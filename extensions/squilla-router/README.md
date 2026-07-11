# SquillaRouter (PoC)

Per-turn model routing for OpenClaw, ported from OpenSquilla's SquillaRouter.
Before each agent run, the plugin classifies the prompt into a tier (`c0`-`c3`,
cheap to strong) and overrides the model for that run via the
`before_model_resolve` hook.

Two classification paths, same ML-first/heuristic-backup chain OpenSquilla
runs in-process — with ALL routing logic inside this plugin. The only external
piece is a generic embedding model:

1. **Semantic** (optional, `config.ml`): embed the prompt via any
   OpenAI-compatible `/v1/embeddings` endpoint (TEI, vLLM, Ollama, or a cloud
   embeddings API — deploy `bge-small-zh-v1.5` or any bilingual embedding
   model), then classify in-plugin by cosine similarity against per-tier
   anchor prompts (`semantic.ts`), with OpenSquilla's margin-upgrade and
   under-routing-safety rules applied in probability space. One embedding
   call per turn; anchors are embedded once per gateway process.
2. **Local heuristics** (always available): the dependency-free rule layer
   below, used when `ml` is not configured or the embedding call fails or
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
            "url": "http://ml-box:8080/v1/embeddings",
            "model": "bge-small-zh-v1.5",
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

`ml` enables semantic routing (all optional except `url`):

- `url` — OpenAI-compatible embeddings endpoint on your model server.
- `model` (default `bge-small-zh-v1.5`) — model name sent in the request; use
  a bilingual embedding model, the anchors are zh+en.
- `apiKey` — sent as `Authorization: Bearer <apiKey>` when set.
- `timeoutMs` (default 2000) — on timeout the turn silently uses the local
  heuristic; routing never blocks on a slow embeddings box.
- `confidenceThreshold` (default 0.5) — semantic answers below this confidence
  flatten to `defaultTier` (OpenSquilla's confidence gate). Flag upgrades and
  sticky routing apply on top of both paths.

Failures are logged at warn level at most once per minute; each affected turn
still routes via the heuristic.

Deploying the embedding model (on the ML box) — any OpenAI-compatible server
works, for example text-embeddings-inference:

```bash
docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id BAAI/bge-small-zh-v1.5
# then: url = http://ml-box:8080/v1/embeddings
```

or Ollama (`ollama pull bge-m3`, `url = http://ml-box:11434/v1/embeddings`,
`model = "bge-m3"`), or a hosted embeddings API.

`sticky` controls KV-cache-aware downgrade blocking (defaults shown above):

- `enabled` — set `false` to route every turn purely by classification,
  ignoring the warm cache. Leave `true` unless you have no provider-side prompt
  caching to protect.
- `maxUserLen` — a turn whose prompt is at most this many characters counts as a
  "continuation" and cannot downgrade below the session's current tier. Longer
  turns are treated as genuinely new work and may re-route freely.
