# SquillaRouter (heuristic PoC)

Per-turn model routing for OpenClaw, ported from OpenSquilla's SquillaRouter
rule layer. Before each agent run, the plugin classifies the prompt into a
tier (`c0`-`c3`, cheap to strong) and overrides the model for that run via the
`before_model_resolve` hook.

This is the dependency-free heuristic subset of SquillaRouter — no ML runtime.
Sources ported (thresholds and keyword lists kept equivalent):

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
          }
        }
      }
    }
  }
}
```

Tiers without a `model` are skipped. If no tier is usable the plugin logs a
warning and disables itself for the session.
