// SquillaRouter plugin entrypoint registers per-turn heuristic model routing.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { classifyTurn, parseRouterConfig, resolveRoute, type StickyContext } from "./router.js";
import { SessionTierStore } from "./session-store.js";

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
    // Per-gateway-lifecycle store of each session's last-served tier; drives
    // KV-cache-aware sticky routing (see router.ts applySticky).
    const sessionTiers = new SessionTierStore();
    api.on("before_model_resolve", (event, ctx) => {
      // Text-complexity heuristics say nothing about vision needs; leave image
      // turns on the session's configured (image-capable) model.
      if (event.attachments?.some((attachment) => attachment.kind === "image")) {
        return;
      }
      const decision = classifyTurn(event.prompt, event.attachments?.length ?? 0);
      const sessionKey = ctx.sessionKey;
      // Sticky only applies when we can identify the session and know its prior
      // tier; without a session key every turn is treated as a fresh route.
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
