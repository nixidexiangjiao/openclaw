# SquillaRouter (PoC)

Per-turn model routing for OpenClaw. The plugin is a **thin client of a
central routing service**: before each agent run it POSTs the prompt to the
service, gets back an abstract tier (`c0`-`c3`, cheap to strong), maps it to a
locally configured model, and overrides the run via `before_model_resolve`.

The wire contract is **generic**: the client depends only on the abstract
`tier` plus a `decisionId` trace handle. Any richer, algorithm-specific data
rides in an opaque `meta` object the client never decodes, so the routing
algorithm behind the service can be swapped with no plugin change.

```
openclaw plugin (thin client)          central service (all routing logic)
  image bypass                           embed message (external embeddings box)
  tier -> model mapping        POST      anchor-similarity classification
  KV-cache sticky            ------->    margin upgrade / under-routing safety
  heuristic fallback         <-------    confidence gate / flag upgrades
  logs decisionId              tier      decision trail store (NO plaintext)
                            decisionId   feedback intake for self-learning
```

Division of labor: the central box owns every routing decision so policy
changes land in one place; the plugin keeps only what must survive a central
outage (heuristic fallback), is inherently local (tier-to-model mapping,
KV-cache sticky, image bypass), or must not leave the machine (attachments).

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
          "defaultTier": "c1",
          "tiers": {
            "c0": { "model": "deepseek/deepseek-v4-flash" },
            "c1": { "model": "deepseek/deepseek-v4-pro" },
            "c2": { "model": "z-ai/glm-5.2" },
            "c3": { "model": "z-ai/glm-5.2" }
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

- Tiers without a `model` are skipped; unconfigured tiers resolve to the
  nearest configured tier, preferring equal-or-higher (no silent downgrades).
- `central.tenantId` keys per-user data on the service (default `"default"`).
- On any central failure/timeout the turn routes via the local heuristic and a
  throttled warning is logged; routing never blocks on the service.
- `sticky` blocks KV-cache-busting downgrades on short continuation turns
  (see HEURISTICS.md §5.3); it applies over central and fallback decisions.
- Image turns are never overridden.

## Deploying the central service

The service is Python (stdlib plus PyMySQL — `pip install PyMySQL`) and lives
in the opensquilla repo at `services/squilla_central/server.py`. Python was
chosen deliberately: OpenSquilla's trained V4 pipeline and self-learning stack
are Python, so upgrading the central classifier later is a drop-in change at
the service's `classify_semantic` seam. Point it at a MySQL database (the
`decisions`/`feedback` tables are created on startup), copy the directory to
the router box, and:

```bash
SQUILLA_EMBEDDINGS_URL=http://ml-box:8080/v1/embeddings \
SQUILLA_EMBEDDINGS_MODEL=bge-small-zh-v1.5 \
SQUILLA_CENTRAL_TOKEN=<token> \
SQUILLA_MYSQL_HOST=db-box SQUILLA_MYSQL_USER=squilla \
SQUILLA_MYSQL_PASSWORD=<password> SQUILLA_MYSQL_DATABASE=squilla_central \
python3 services/squilla_central/server.py --host 0.0.0.0 --port 8710
```

Optional env: `SQUILLA_MYSQL_PORT` (default `3306`),
`SQUILLA_EMBEDDINGS_API_KEY`, `SQUILLA_EMBEDDINGS_TIMEOUT_S`,
`SQUILLA_DEFAULT_TIER` (c0-c3), `SQUILLA_CONFIDENCE_THRESHOLD` (0-1),
`SQUILLA_POLICY_VERSION` (stamped on every decision for reproducibility).

The embeddings endpoint is any OpenAI-compatible server, e.g.:

```bash
docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id BAAI/bge-small-zh-v1.5
```

If embeddings fail, the central service still answers using the heuristic
band rules (recorded with the heuristic band in the trail), so clients only
fall back to their local heuristic when the central service itself is down.

## Classification internals

See `HEURISTICS.md` for the full walkthrough. Sources ported from OpenSquilla
(thresholds and keyword lists kept equivalent): bands from
`engine/routing/heuristic.py`, flags from the v4 bundle `flags.py` +
`router.runtime.yaml`, flag upgrades from `predictor.py`
`_apply_flag_overrides`, margin upgrade / under-routing safety from the v4
postprocess, sticky from `_apply_sticky_tier`.
