// SquillaRouter plugin entrypoint registers per-turn model routing:
// remote ML classification when configured, local heuristics as fallback.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { classifyRemote } from "./ml-client.js";
import {
  classifyTurn,
  mlRouteDecision,
  parseRouterConfig,
  resolveRoute,
  type RouteDecision,
  type StickyContext,
} from "./router.js";
import { SessionTierStore } from "./session-store.js";

// Remote failures are expected operational noise (box restarts, network
// blips); warn once per window so the log shows the degradation without a
// line per turn.
const ML_WARN_INTERVAL_MS = 60_000;

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
        "squilla-router: config.ml is present but has no usable url; remote ML disabled",
      );
    }
    // Per-gateway-lifecycle store of each session's last-served tier and
    // recent route history (sticky routing + ML history context).
    const sessionStore = new SessionTierStore();
    let lastMlWarnAt = 0;

    api.on("before_model_resolve", async (event, ctx) => {
      // Text-complexity heuristics say nothing about vision needs; leave image
      // turns on the session's configured (image-capable) model.
      if (event.attachments?.some((attachment) => attachment.kind === "image")) {
        return;
      }
      const sessionKey = ctx.sessionKey;
      const session = sessionKey ? sessionStore.get(sessionKey) : undefined;

      // ML first, heuristic on any failure — the same ML-first/heuristic-backup
      // chain OpenSquilla runs in-process, with the ML half moved behind HTTP.
      let decision: RouteDecision | undefined;
      let mlExtras: { difficulty?: number; margin?: number } = {};
      if (config.ml) {
        const result = await classifyRemote(config.ml, event.prompt, session?.history ?? []);
        if (result.ok) {
          decision = mlRouteDecision(result.classification, config);
          mlExtras = {
            ...(result.classification.difficulty !== undefined
              ? { difficulty: result.classification.difficulty }
              : {}),
            ...(result.classification.margin !== undefined
              ? { margin: result.classification.margin }
              : {}),
          };
        } else {
          const now = Date.now();
          if (now - lastMlWarnAt >= ML_WARN_INTERVAL_MS) {
            lastMlWarnAt = now;
            api.logger.warn(
              `squilla-router: ML classify failed (${result.reason}); using local heuristic`,
            );
          }
        }
      }
      if (!decision) {
        decision = classifyTurn(event.prompt, event.attachments?.length ?? 0);
      }

      // Sticky only applies when we can identify the session and know its prior
      // tier; without a session key every turn is treated as a fresh route.
      const stickyCtx: StickyContext | undefined = session
        ? { lastTier: session.tier, promptLen: event.prompt.length }
        : undefined;
      const route = resolveRoute(config, decision, stickyCtx);
      if (!route) {
        return;
      }
      if (sessionKey) {
        sessionStore.record(sessionKey, route.resolvedTier, {
          text: event.prompt,
          routeClass: route.routeClass,
          ...mlExtras,
        });
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
