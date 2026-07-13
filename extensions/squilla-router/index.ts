// SquillaRouter plugin entrypoint: a thin client of the central routing
// service. Routing triggers ONLY when the session's selected model is one of
// the configured virtual routing ids (profiles keys); real models are never
// intercepted. The central box owns all routing intelligence; this side keeps
// only what must run in-process (applying the model override), is inherently
// local (tier-to-model mapping, KV-cache sticky, image handling), or keeps
// routing usable when central is down (a crude size-based fallback).
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { routeRemote } from "./central-client.js";
import {
  fallbackTier,
  matchProfile,
  parseRouterConfig,
  resolveRoute,
  type RouteSource,
  type StickyContext,
  type Tier,
} from "./router.js";
import { SessionTierStore } from "./session-store.js";

// Central failures are expected operational noise (box restarts, network
// blips); warn once per window so the log shows the degradation without a
// line per turn.
const CENTRAL_WARN_INTERVAL_MS = 60_000;

export default definePluginEntry({
  id: "squilla-router",
  name: "SquillaRouter",
  description:
    "Routes turns on virtual routing model ids to a configured model tier via a central routing service.",
  register(api) {
    const config = parseRouterConfig(api.pluginConfig);
    if (!config) {
      api.logger.warn(
        "squilla-router: no usable routing profiles configured " +
          '(plugins.entries.squilla-router.config.profiles."<virtual-id>".tiers); routing disabled',
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
      // Trigger gate: only turns whose requested model is a configured virtual
      // routing id are routed. Sessions on real models pass through untouched.
      const match = matchProfile(config.profiles, ctx.modelProviderId, ctx.modelId);
      if (!match) {
        return;
      }
      const { key: profileKey, profile } = match;
      const sessionKey = ctx.sessionKey;
      const attachmentCount = event.attachments?.length ?? 0;

      // From here on we MUST return an override: the virtual id resolves to no
      // real model, so passing through would fail model resolution.
      //
      // Image turns skip central (text-complexity says nothing about vision)
      // and go to the profile's strongest configured tier — the model most
      // likely to be vision-capable.
      const hasImage = event.attachments?.some((attachment) => attachment.kind === "image");

      let tier: Tier | undefined;
      let decisionId: string | undefined;
      let source: RouteSource = "fallback";
      if (!hasImage && config.central) {
        const result = await routeRemote(config.central, {
          sessionKey: sessionKey ?? "",
          profile: profileKey,
          message: event.prompt,
          attachmentCount,
        });
        if (result.ok) {
          tier = result.route.tier;
          decisionId = result.route.decisionId;
          source = "central";
        } else {
          const now = Date.now();
          if (now - lastCentralWarnAt >= CENTRAL_WARN_INTERVAL_MS) {
            lastCentralWarnAt = now;
            api.logger.warn(
              `squilla-router: central route failed (${result.reason}); using local fallback`,
            );
          }
        }
      }
      if (tier === undefined) {
        tier = hasImage ? "c3" : fallbackTier(event.prompt, attachmentCount, profile.defaultTier);
      }

      // Sticky only applies when we can identify the session and know its prior
      // tier; without a session key every turn is treated as a fresh route.
      const lastTier = sessionKey ? sessionTiers.get(sessionKey) : undefined;
      const stickyCtx: StickyContext | undefined =
        lastTier !== undefined ? { lastTier, promptLen: event.prompt.length } : undefined;
      const route = resolveRoute(profile, config.sticky, tier, stickyCtx);
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
        `squilla-router: profile=${profileKey} source=${source} ` +
          `tier=${route.resolvedTier} model=${route.target.model}` +
          (decisionId ? ` decision=${decisionId}` : "") +
          (route.stuck ? ` (sticky: held from ${route.desiredTier})` : ""),
      );
      return {
        modelOverride: route.target.model,
        ...(route.target.provider ? { providerOverride: route.target.provider } : {}),
      };
    });
  },
});
