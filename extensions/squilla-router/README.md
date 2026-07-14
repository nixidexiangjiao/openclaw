# SquillaRouter (PoC)

Per-turn model routing for OpenClaw, triggered by **virtual routing model
ids**. Operators define routing profiles in config, each keyed by a virtual
`provider/modelId` (e.g. `squilla/auto`). A session opts into smart routing by
selecting that virtual model; sessions on real models are never intercepted.
On each routed turn the plugin POSTs the prompt (plus the profile key) to a
**central routing service**, gets back an abstract tier (`c0`-`c3`, cheap to
strong), maps it through the profile's tier table to a real model, and
overrides the run via `before_model_resolve`.

The wire contract is **generic**: the client depends only on the abstract
`tier` plus a `decisionId` trace handle. Any richer, algorithm-specific data
rides in an opaque `meta` object the client never decodes, so the routing
algorithm behind the service can be swapped with no plugin change.

```
openclaw plugin (thin client)          central service (all routing logic)
  virtual-id trigger gate                embed message (external embeddings box)
  tier -> model per profile     POST     anchor-similarity classification
  KV-cache sticky             ------->   margin upgrade / under-routing safety
  crude size-based fallback   <-------   confidence gate / flag upgrades
  image -> strongest tier       tier     decision trail store (NO plaintext)
  logs decisionId            decisionId  feedback intake for self-learning
```

Division of labor: the central box owns every routing decision so policy
changes land in one place; the plugin holds no routing intelligence. It keeps
only the trigger gate and in-process override, what is inherently local
(profile tier-to-model mapping, KV-cache sticky, image handling), and a crude
size-based fallback for when central is unreachable — deliberately NOT a copy
of the central rule layer (that would duplicate policy and drift). All plugin
config comes from `openclaw.json`; the central control plane (tokenhub) feeds
the central service only, never the plugin.

## Privacy and traceability contract

- The wire carries the message text (internal deployment).
- The central store (MySQL) **never** persists it: the `decisions` schema has
  no text column — only derived data (char length, flags, probabilities, the
  base -> gated -> final tier trail, nearest anchors, the embedding vector).
- Every route response carries a `decisionId`. The plugin logs it next to the
  session transcript — the transcript is where plaintext lives, the central
  trail is where the reasoning lives, and the id joins them.

### Debugging runbook (查问题)

1. Start from metrics: `GET /v1/stats?tenantId=...` — tier/band distribution
   and downvote counts per tenant.
2. Find the turn: `GET /v1/decisions?tenantId=...&sessionKey=...` lists a
   session's recent decisions newest-first.
3. Explain the decision: `GET /v1/decisions/{decisionId}` returns the full
   trail — classifier tier, gated tier, final tier, probabilities, margin,
   triggered flags, and `topAnchors` ("which of our anchor prompts the message
   resembled"), which explains the semantics without storing the message.
4. Need the actual text? Grep the _client_ gateway log for the decisionId —
   the debug line sits next to the session transcript on the user's machine.

## Configuration (plugin side)

```json
{
  "plugins": {
    "entries": {
      "squilla-router": {
        "enabled": true,
        "config": {
          "profiles": {
            "squilla/auto": {
              "defaultTier": "c1",
              "tiers": {
                "c0": { "model": "deepseek/deepseek-v4-flash" },
                "c1": { "model": "deepseek/deepseek-v4-pro" },
                "c2": { "model": "z-ai/glm-5.2" },
                "c3": { "model": "z-ai/glm-5.2" }
              }
            },
            "squilla/auto-max": {
              "defaultTier": "c2",
              "tiers": {
                "c2": { "model": "z-ai/glm-5.2" },
                "c3": { "model": "z-ai/glm-5.2", "provider": "zai" }
              }
            }
          },
          "sticky": { "enabled": true, "maxUserLen": 200 },
          "central": {
            "url": "http://router-box:8710/v1/route",
            "tenantId": "team-a",
            "apiKey": "<token>",
            "timeoutMs": 2000
          }
        }
      }
    }
  }
}
```

- **Trigger**: routing runs only when the session's selected model matches a
  `profiles` key — matched as `provider/modelId` first, then as the bare
  modelId (OpenClaw model ids may themselves contain `/`). Multiple virtual
  ids can coexist, each with its own tier table. The virtual id never reaches
  model resolution: once matched, the plugin always overrides.
- Tiers without a `model` are skipped; unconfigured tiers resolve to the
  nearest configured tier, preferring equal-or-higher (no silent downgrades).
- `central.tenantId` keys per-user data on the service (default `"default"`);
  the triggering profile key is sent as `profile` so central keeps per-profile
  stats and can serve per-profile policy later.
- On any central failure/timeout the turn routes via a crude size-based
  fallback (`fallbackTier`) and a throttled warning is logged; routing never
  blocks on the service. The fallback's one tunable knob is the profile's
  `defaultTier` — all fallback config is `openclaw.json`.
- `sticky` blocks KV-cache-busting downgrades on short continuation turns; it
  applies over central and fallback decisions.
- Image turns skip central (text complexity says nothing about vision) and go
  to the profile's strongest configured tier — the model most likely to be
  vision-capable.

## Deploying the central service

The service is Python and lives in the opensquilla repo at
`services/squilla_central/server.py`. It classifies with OpenSquilla's **real
V4 Phase 3 model** — the trained BGE-ONNX + LightGBM + MLP ensemble, run
in-process via `V4Phase3Strategy` (BGE runs inside the model bundle as ONNX, so
there is no external embeddings endpoint). Point it at a MySQL database (the
`decisions`/`feedback` tables are created on startup), then:

```bash
SQUILLA_CENTRAL_TOKEN=<token> \
SQUILLA_MYSQL_HOST=db-box SQUILLA_MYSQL_USER=squilla \
SQUILLA_MYSQL_PASSWORD=<password> SQUILLA_MYSQL_DATABASE=squilla_central \
PYTHONPATH=src python3 services/squilla_central/server.py --host 0.0.0.0 --port 8710
```

The V4 path needs, on the box:

- `opensquilla[recommended]` (numpy / lightgbm / onnxruntime / scikit-learn /
  joblib), and
- the Git-LFS model bundle under
  `opensquilla/squilla_router/models/v4.2_phase3_inference` — run `git lfs pull`
  (weights are ~40 MB LightGBM + ~24 MB BGE-ONNX).

Optional env: `SQUILLA_MYSQL_PORT` (default `3306`), `SQUILLA_DEFAULT_TIER`
(c0-c3), `SQUILLA_CONFIDENCE_THRESHOLD` (0-1), `SQUILLA_POLICY_VERSION` (stamped
on every decision for reproducibility), `SQUILLA_V4_BUNDLE_DIR` (override the
bundle path), `SQUILLA_V4=0` (force the heuristic — see below).

If the V4 model or its deps/bundle are unavailable, the service degrades to its
own dependency-free band heuristic (recorded in the trail), so routing still
answers on a fresh box before `git lfs pull`. The plugin only falls back to its
own crude local guess when the central service itself is unreachable.

## Design

See [`DESIGN.md`](DESIGN.md) for the full design (architecture, request flow,
control-plane boundary) and the drawio diagrams under `design/`. All routing
intelligence — embedding, anchor-similarity classification, margin/under-route
safety, confidence gate, flag upgrades — lives in the central service
(`services/squilla_central/server.py`, ported from OpenSquilla). The plugin
holds none of it; its only offline logic is `fallbackTier`, a crude size-based
guess used solely when central is unreachable, and `applySticky`
(KV-cache-aware, mirrors OpenSquilla `_apply_sticky_tier`).
