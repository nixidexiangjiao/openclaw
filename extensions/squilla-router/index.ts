// SquillaRouter plugin entrypoint registers per-turn heuristic model routing.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { classifyTurn, parseRouterConfig, resolveRoute } from "./router.js";

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
    api.on("before_model_resolve", (event) => {
      // Text-complexity heuristics say nothing about vision needs; leave image
      // turns on the session's configured (image-capable) model.
      if (event.attachments?.some((attachment) => attachment.kind === "image")) {
        return;
      }
      const decision = classifyTurn(event.prompt, event.attachments?.length ?? 0);
      const route = resolveRoute(config, decision);
      if (!route) {
        return;
      }
      api.logger.debug?.(
        `squilla-router: band=${route.band} class=${route.routeClass} ` +
          `tier=${route.resolvedTier} model=${route.target.model}` +
          (route.flagUpgraded ? " (flag upgrade)" : ""),
      );
      return {
        modelOverride: route.target.model,
        ...(route.target.provider ? { providerOverride: route.target.provider } : {}),
      };
    });
  },
});
