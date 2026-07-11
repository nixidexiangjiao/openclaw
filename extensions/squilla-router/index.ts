// SquillaRouter plugin entrypoint registers per-turn model routing:
// embedding-based semantic classification when configured, local heuristics
// as fallback. Only the embedding model runs externally; all routing logic
// lives in this plugin.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { embedTexts } from "./embeddings-client.js";
import {
  classifyTurn,
  parseRouterConfig,
  resolveRoute,
  semanticRouteDecision,
  type MlRouterConfig,
  type RouteDecision,
  type StickyContext,
} from "./router.js";
import { classifyEmbedding, flatAnchorTexts } from "./semantic.js";
import { SessionTierStore } from "./session-store.js";

// Remote failures are expected operational noise (box restarts, network
// blips); warn once per window so the log shows the degradation without a
// line per turn.
const ML_WARN_INTERVAL_MS = 60_000;

// Anchor embeddings are computed once per process (anchors are compile-time
// constants). A failed load retries on the next turn instead of poisoning the
// cache; turns in between route via the heuristic.
class AnchorCache {
  private vectors: number[][] | null = null;
  private loading: Promise<number[][] | null> | null = null;

  constructor(private readonly config: MlRouterConfig) {}

  async get(): Promise<number[][] | null> {
    if (this.vectors) {
      return this.vectors;
    }
    this.loading ??= embedTexts(this.config, flatAnchorTexts()).then((result) => {
      this.loading = null;
      if (!result.ok) {
        return null;
      }
      this.vectors = result.vectors;
      return this.vectors;
    });
    return this.loading;
  }
}

export default definePluginEntry({
  id: "squilla-router",
  name: "SquillaRouter",
  description: "Routes each turn to a configured model tier using OpenSquilla heuristics.",
  register(api) {
    const config = parseRouterConfig(api.pluginConfig);
    if (!config) {
      api.logger.warn(
        "squilla-router: no usable tiers configured " +
          "(plugins.entries.squilla-router.config.tiers.{c0..c3}.model); routing disabled",
      );
      return;
    }
    if (!config.ml && (api.pluginConfig as Record<string, unknown> | undefined)?.ml) {
      api.logger.warn(
        "squilla-router: config.ml is present but has no usable url; semantic routing disabled",
      );
    }
    // Per-gateway-lifecycle store of each session's last-served tier; drives
    // KV-cache-aware sticky routing (see router.ts applySticky).
    const sessionTiers = new SessionTierStore();
    const anchors = config.ml ? new AnchorCache(config.ml) : null;
    let lastMlWarnAt = 0;
    const warnThrottled = (message: string) => {
      const now = Date.now();
      if (now - lastMlWarnAt >= ML_WARN_INTERVAL_MS) {
        lastMlWarnAt = now;
        api.logger.warn(message);
      }
    };

    api.on("before_model_resolve", async (event, ctx) => {
      // Text-complexity heuristics say nothing about vision needs; leave image
      // turns on the session's configured (image-capable) model.
      if (event.attachments?.some((attachment) => attachment.kind === "image")) {
        return;
      }

      // Semantic first, heuristic on any failure — the same ML-first/
      // heuristic-backup chain OpenSquilla runs in-process, with the model
      // inference moved behind a generic embeddings endpoint.
      let decision: RouteDecision | undefined;
      if (config.ml && anchors) {
        const anchorVectors = await anchors.get();
        if (!anchorVectors) {
          warnThrottled("squilla-router: anchor embedding failed; using local heuristic");
        } else {
          const query = await embedTexts(config.ml, [event.prompt]);
          if (query.ok) {
            const semantic = classifyEmbedding(query.vectors[0], anchorVectors);
            decision = semanticRouteDecision(semantic, event.prompt, config);
          } else {
            warnThrottled(
              `squilla-router: embedding failed (${query.reason}); using local heuristic`,
            );
          }
        }
      }
      if (!decision) {
        decision = classifyTurn(event.prompt, event.attachments?.length ?? 0);
      }

      // Sticky only applies when we can identify the session and know its prior
      // tier; without a session key every turn is treated as a fresh route.
      const sessionKey = ctx.sessionKey;
      const lastTier = sessionKey ? sessionTiers.get(sessionKey) : undefined;
      const stickyCtx: StickyContext | undefined =
        lastTier !== undefined ? { lastTier, promptLen: event.prompt.length } : undefined;
      const route = resolveRoute(config, decision, stickyCtx);
      if (!route) {
        return;
      }
      if (sessionKey) {
        sessionTiers.set(sessionKey, route.resolvedTier);
      }
      api.logger.debug?.(
        `squilla-router: band=${route.band} class=${route.routeClass} ` +
          `tier=${route.resolvedTier} model=${route.target.model}` +
          (route.flagUpgraded ? " (flag upgrade)" : "") +
          (route.stuck ? ` (sticky: held from ${route.desiredTier})` : ""),
      );
      return {
        modelOverride: route.target.model,
        ...(route.target.provider ? { providerOverride: route.target.provider } : {}),
      };
    });
  },
});
