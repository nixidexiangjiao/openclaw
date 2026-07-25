// SquillaRouter plugin entrypoint: a pure pass-through client of the central
// routing service. Routing triggers ONLY when the session's selected model is
// one of the configured virtual routing ids (profiles keys); real models are
// never intercepted.
//
// The plugin makes no routing judgment of its own — no classification, no
// KV-cache sticky, no image handling, no tier snapping. It relays the turn,
// applies the tier central returns, and serves the profile's defaultTier when
// central is unreachable.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { routeRemote } from "./central-client.js";
import {
  availableTiers,
  matchProfile,
  parseRouterConfig,
  targetForTier,
  type RouteSource,
  type Tier,
} from "./router.js";

// Central failures are expected operational noise (box restarts, network
// blips); warn once per window so the log shows the degradation without a
// line per turn.
const CENTRAL_WARN_INTERVAL_MS = 60_000;

export default definePluginEntry({
  id: "squilla-router",
  name: "SquillaRouter",
  description:
    "Routes turns on virtual routing model ids to a model tier chosen by a central routing service.",
  register(api) {
    const config = parseRouterConfig(api.pluginConfig);
    if (!config) {
      api.logger.warn(
        "squilla-router: no usable routing profiles configured " +
          '(plugins.entries.squilla-router.config.profiles."<virtual-id>".tiers); routing disabled',
      );
      return;
    }
    if (!config.central) {
      api.logger.warn(
        "squilla-router: config.central has no usable url; every turn will serve " +
          "its profile's defaultTier",
      );
    }
    let lastCentralWarnAt = 0;

    api.on("before_model_resolve", async (event, ctx) => {
      // Trigger gate: only turns whose requested model is a configured virtual
      // routing id are routed. Sessions on real models pass through untouched.
      const match = matchProfile(config.profiles, ctx.modelProviderId, ctx.modelId);
      if (!match) {
        return;
      }
      const { key: profileKey, profile } = match;

      // From here on we MUST return an override: the virtual id resolves to no
      // real model, so passing through would fail model resolution.
      let tier: Tier = profile.defaultTier;
      let source: RouteSource = "default";
      let decisionId: string | undefined;
      if (config.central) {
        const result = await routeRemote(config.central, {
          sessionKey: ctx.sessionKey ?? "",
          profile: profileKey,
          message: event.prompt,
          attachmentCount: event.attachments?.length ?? 0,
          hasImage: event.attachments?.some((a) => a.kind === "image") ?? false,
          availableTiers: availableTiers(profile),
        });
        if (result.ok) {
          tier = result.route.tier;
          source = "central";
          decisionId = result.route.decisionId;
        } else {
          const now = Date.now();
          if (now - lastCentralWarnAt >= CENTRAL_WARN_INTERVAL_MS) {
            lastCentralWarnAt = now;
            api.logger.warn(
              `squilla-router: central route failed (${result.reason}); serving defaultTier`,
            );
          }
        }
      }

      const target = targetForTier(profile, tier);
      // decisionId is the trace handle: this line lives next to the session
      // transcript (which holds the plaintext), while the central store holds
      // the plaintext-free trail under the same id.
      api.logger.debug?.(
        `squilla-router: profile=${profileKey} source=${source} ` +
          `tier=${tier} model=${target.model}` +
          (decisionId ? ` decision=${decisionId}` : ""),
      );
      return {
        modelOverride: target.model,
        ...(target.provider ? { providerOverride: target.provider } : {}),
      };
    });
  },
});
