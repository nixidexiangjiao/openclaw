// SquillaRouter plugin entrypoint: a thin client of the central routing
// service. The central box owns all routing intelligence; this side keeps only
// what must survive a central outage or is inherently local — image bypass,
// tier-to-model mapping, KV-cache sticky, and the heuristic fallback.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { routeRemote } from "./central-client.js";
import {
  classifyTurn,
  parseRouterConfig,
  resolveRoute,
  type RouteDecision,
  type StickyContext,
} from "./router.js";
import { SessionTierStore } from "./session-store.js";

// Central failures are expected operational noise (box restarts, network
// blips); warn once per window so the log shows the degradation without a
// line per turn.
const CENTRAL_WARN_INTERVAL_MS = 60_000;

export default definePluginEntry({
  id: "squilla-router",
  name: "SquillaRouter",
  description: "Routes each turn to a configured model tier via a central routing service.",
  register(api) {
    const config = parseRouterConfig(api.pluginConfig);
    if (!config) {
      api.logger.warn(
        "squilla-router: no usable tiers configured " +
          "(plugins.entries.squilla-router.config.tiers.{c0..c3}.model); routing disabled",
      );
      return;
    }
    if (!config.central && (api.pluginConfig as Record<string, unknown> | undefined)?.central) {
      api.logger.warn(
        "squilla-router: config.central is present but has no usable url; central routing disabled",
      );
    }
    // Per-gateway-lifecycle store of each session's last-served tier; drives
    // KV-cache-aware sticky routing (see router.ts applySticky).
    const sessionTiers = new SessionTierStore();
    let lastCentralWarnAt = 0;

    api.on("before_model_resolve", async (event, ctx) => {
      // Text-complexity routing says nothing about vision needs; leave image
      // turns on the session's configured (image-capable) model.
      if (event.attachments?.some((attachment) => attachment.kind === "image")) {
        return;
      }
      const sessionKey = ctx.sessionKey;
      const attachmentCount = event.attachments?.length ?? 0;

      // Central first, local heuristic on any failure — routing never blocks
      // on the service being slow or down.
      let decision: RouteDecision | undefined;
      let decisionId: string | undefined;
      if (config.central) {
        const result = await routeRemote(config.central, {
          sessionKey: sessionKey ?? "",
          message: event.prompt,
          attachmentCount,
        });
        if (result.ok) {
          decision = result.route.decision;
          decisionId = result.route.decisionId;
        } else {
          const now = Date.now();
          if (now - lastCentralWarnAt >= CENTRAL_WARN_INTERVAL_MS) {
            lastCentralWarnAt = now;
            api.logger.warn(
              `squilla-router: central route failed (${result.reason}); using local heuristic`,
            );
          }
        }
      }
      if (!decision) {
        decision = classifyTurn(event.prompt, attachmentCount);
      }

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
      // decisionId is the trace handle: this line lives next to the session
      // transcript (which holds the plaintext), while the central store holds
      // the plaintext-free trail under the same id.
      api.logger.debug?.(
        `squilla-router: band=${route.band} class=${route.routeClass} ` +
          `tier=${route.resolvedTier} model=${route.target.model}` +
          (decisionId ? ` decision=${decisionId}` : " (local heuristic)") +
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
