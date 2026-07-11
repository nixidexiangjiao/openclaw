# SquillaRouter (PoC)

Per-turn model routing for OpenClaw, ported from OpenSquilla's SquillaRouter.
Before each agent run, the plugin classifies the prompt into a tier (`c0`-`c3`,
cheap to strong) and overrides the model for that run via the
`before_model_resolve` hook.

Two classification paths, same chain OpenSquilla runs in-process:

1. **Remote ML** (optional, `config.ml`): POST the prompt plus recent route
   history to an external SquillaRouter classification service (opensquilla
   `python -m opensquilla.squilla_router.http_service`) running the full
   BGE + LightGBM + MLP pipeline on a box that can afford the ML runtime.
2. **Local heuristics** (always available): the dependency-free rule layer
   below, used when `ml` is not configured or the service call fails or
   times out.

Heuristic sources ported (thresholds and keyword lists kept equivalent):

- bands: opensquilla `src/opensquilla/engine/routing/heuristic.py`
- flags: v4 bundle `runtime_src/src/router/flags.py` + `router.runtime.yaml`
- flag upgrades: v4 bundle `predictor.py` `_apply_flag_overrides`

## Routing behavior

1. Band classification: very long or multi-file input -> `c3`; code fences,
   long material, or non-image attachments -> `c2`; short plain text -> `c0`;
   medium plain text -> `c1`; ambiguous mid-length text -> the configured
   `defaultTier`.
2. Flag upgrades (never downgrades): high-risk keywords (deploy, rollback,
   production, 生产, 删除, ...) -> at least `c2`; debug signals combined with
   long context -> at least `c2`; repo/architecture keywords -> at least `c1`.
3. Image turns are never overridden — the session's configured model stays.
4. Unconfigured tiers resolve to the nearest configured tier, preferring
   equal-or-higher so a missing tier never silently downgrades a turn.
5. KV-cache-aware sticky routing (on by default): on a short continuation turn,
   never route below the tier the session was already on. Switching to a cheaper
   model would drop the provider-side prompt cache and re-pay the whole context
   uncached, which usually costs more than the per-token saving. Upgrades are
   still allowed — a genuinely harder turn is worth the cache miss.

## Configuration

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
          "ml": {
            "url": "http://ml-box:8701/v1/classify",
            "apiKey": "<token>",
            "timeoutMs": 2000,
            "confidenceThreshold": 0.5
          }
        }
      }
    }
  }
}
```

Tiers without a `model` are skipped. If no tier is usable the plugin logs a
warning and disables itself for the session.

`ml` enables remote ML classification (all optional except `url`):

- `url` — full classify endpoint of the external service.
- `apiKey` — sent as `Authorization: Bearer <apiKey>`; pair with
  `OPENSQUILLA_ROUTER_TOKEN` on the service.
- `timeoutMs` (default 2000) — on timeout the turn silently uses the local
  heuristic; routing never blocks on a slow ML box.
- `confidenceThreshold` (default 0.5) — ML answers below this confidence
  flatten to `defaultTier` (OpenSquilla's confidence gate).

Failures are logged at warn level at most once per minute; each affected turn
still routes via the heuristic. Sticky routing applies on top of both paths.

Deploying the service (on the ML box):

```bash
pip install 'opensquilla[recommended]'   # or a source checkout + git lfs pull
OPENSQUILLA_ROUTER_TOKEN=<token> \
  python -m opensquilla.squilla_router.http_service --host 0.0.0.0 --port 8701
```

The service refuses to start without a working ML runtime, and answers 503 if
the runtime breaks later — the plugin then falls back to heuristics instead of
mistaking degraded default-tier answers for ML output.

`sticky` controls KV-cache-aware downgrade blocking (defaults shown above):

- `enabled` — set `false` to route every turn purely by classification,
  ignoring the warm cache. Leave `true` unless you have no provider-side prompt
  caching to protect.
- `maxUserLen` — a turn whose prompt is at most this many characters counts as a
  "continuation" and cannot downgrade below the session's current tier. Longer
  turns are treated as genuinely new work and may re-route freely.
