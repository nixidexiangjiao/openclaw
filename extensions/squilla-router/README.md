# SquillaRouter (PoC)

Per-turn model routing for OpenClaw, triggered by **virtual routing model
ids**. Operators define routing profiles in config, each keyed by a virtual
`provider/modelId` (e.g. `squilla/auto`). A session opts into smart routing by
selecting that virtual model; sessions on real models are never intercepted.
On each routed turn the plugin POSTs the turn to a **central routing service**,
gets back an abstract tier (`c0`-`c3`, cheap to strong), maps it through the
profile's tier table to a real model, and overrides the run via
`before_model_resolve`.

The plugin is a **pure pass-through client**: it holds no routing judgment at
all — no classification, no KV-cache sticky, no image handling, no tier
snapping. Every one of those decisions is made centrally. The only thing the
plugin decides on its own is what to serve when central is unreachable, and
that is not a decision so much as a constant: the profile's `defaultTier`.

The wire contract is **generic**: the client depends only on the abstract
`tier` plus a `decisionId` trace handle. Any richer, algorithm-specific data
rides in an opaque `meta` object the client never decodes, so the routing
algorithm behind the service can be swapped with no plugin change.

```
openclaw plugin (pure pass-through)    central service (ALL routing logic)
  virtual-id trigger gate                real V4 Phase 3 ensemble
  relays turn + availableTiers  POST     snap to a servable tier
  + hasImage                  ------->   image turns -> strongest tier
  applies returned tier       <-------   KV-cache sticky (from the store)
  tier -> model per profile     tier     decision trail store (NO plaintext)
  defaultTier iff central down decisionId  feedback intake for self-learning
  logs decisionId
```

Why this split: routing policy changes then land in exactly one place, and —
because the client applies the returned tier verbatim — the tier central
records is exactly the tier that was served. That makes `decisions.final_tier`
a truthful self-learning label instead of an intention the client might have
overridden locally.

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
   trail — `classifierTier` (what the model picked), `finalTier` (what was
   actually served, after snap + sticky), `stuck` (whether sticky held the
   previous tier), probabilities, margin, triggered flags, and `topAnchors`,
   which explains the semantics without storing the message.
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
- Tiers without a `model` are skipped. The configured tier list is sent to
  central as `availableTiers`, so central returns a tier the profile can
  actually serve and the plugin does a **pure table lookup**, never a snap.
- `defaultTier` is pinned at startup to a tier the profile really configures,
  preferring equal-or-stronger over a silent downgrade. It is used only when
  central is unreachable (and as the lookup's last resort if central ignores
  `availableTiers`).
- `central.tenantId` keys per-user data on the service (default `"default"`);
  the triggering profile key is sent as `profile` so central keeps per-profile
  stats and can serve per-profile policy later.
- On any central failure/timeout the turn serves the profile's `defaultTier`
  and a throttled warning is logged; routing never blocks on the service.
- There is no `sticky` config here anymore. KV-cache sticky moved to the
  central service (`SQUILLA_STICKY`, `SQUILLA_STICKY_MAX_USER_LEN`), where the
  previous served tier is read from the decision store — which is also correct
  across multiple OpenClaw instances and restarts, unlike per-process memory.
- Image turns are **not** special-cased here either: the plugin reports
  `hasImage` and central decides (today: skip the text classifier, serve the
  strongest available tier).

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
on every decision for reproducibility), `SQUILLA_STICKY` (`0` disables
KV-cache sticky), `SQUILLA_STICKY_MAX_USER_LEN` (default `200` — the longest
turn still treated as a continuation), `SQUILLA_V4_BUNDLE_DIR` (override the
bundle path), `SQUILLA_V4=0` (force the heuristic — see below).

If the V4 model or its deps/bundle are unavailable, the service degrades to its
own dependency-free band heuristic (recorded in the trail), so routing still
answers on a fresh box before `git lfs pull`. Snapping and sticky still apply
on that path — the plugin serves its `defaultTier` only when the central
service itself is unreachable.

## Design

See [`DESIGN.md`](DESIGN.md) for the full design (architecture, request flow,
control-plane boundary) and the drawio diagrams under `design/`. All routing
intelligence — feature assembly, the V4 ensemble, postprocess cascade, tier
snapping, image handling, and KV-cache sticky — lives in the central service
(`services/squilla_central/server.py`, ported from OpenSquilla). The plugin
holds none of it: `router.ts` is a trigger gate plus two lookups, and
`central-client.ts` is one HTTP call.
