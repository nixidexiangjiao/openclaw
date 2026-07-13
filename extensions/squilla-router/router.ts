// SquillaRouter plugin-local logic: routing-profile matching, tier→model
// resolution, KV-cache sticky, a crude central-outage fallback, and config
// parsing. All real routing intelligence lives in the central service; this
// file holds only what must run in-process.
//
// Trigger contract: routing runs ONLY when the session's selected model is one
// of the configured virtual routing ids (the `profiles` keys). Real models are
// never intercepted. A virtual id resolves to nothing outside this plugin, so
// once a profile matches the hook MUST return an override.

export const TEXT_TIERS = ["c0", "c1", "c2", "c3"] as const;
export type Tier = (typeof TEXT_TIERS)[number];

/** Where the chosen tier came from — for logs only. */
export type RouteSource = "central" | "fallback";

export type TierTarget = {
  model: string;
  provider?: string;
};

// One routing profile, keyed in config by the virtual model id that triggers
// it (e.g. "squilla/auto"). Each profile carries its own tier→model table so
// different virtual ids can route across different model sets.
export type RouteProfile = {
  tiers: Partial<Record<Tier, TierTarget>>;
  defaultTier: Tier;
};

// KV-cache-aware sticky routing. Switching models mid-session throws away the
// provider-side prompt cache, so a "cheaper" tier can cost MORE (re-paying the
// whole context uncached). Mirrors OpenSquilla predictor.py _apply_sticky_tier:
// block downgrades on short continuation turns; allow upgrades (a hard turn is
// worth the cache miss).
export type StickyConfig = {
  enabled: boolean;
  maxUserLen: number;
};

// Central routing service (services/squilla_central, deployed on your ML box).
// The plugin sends the message and receives an abstract tier; every bit of
// routing intelligence runs centrally. Any failure falls back to the crude
// local guess so routing never blocks on the service.
export type CentralConfig = {
  /** Central route endpoint, e.g. http://router-box:8710/v1/route */
  url: string;
  /** Tenant identifier the central service keys per-user data by. */
  tenantId: string;
  apiKey?: string;
  timeoutMs: number;
};

// All plugin config comes from openclaw.json (bootstrap + the sole source for
// the fallback path). tokenhub distributes policy to the central service only,
// never to the plugin.
export type SquillaRouterConfig = {
  profiles: Record<string, RouteProfile>;
  sticky: StickyConfig;
  central?: CentralConfig;
};

const CENTRAL_DEFAULT_TIMEOUT_MS = 2_000;
const CENTRAL_DEFAULT_TENANT = "default";

// Default matches OpenSquilla's sticky_tier.max_user_len. Enabled by default
// here (unlike OpenSquilla's shipped default-off): OpenSquilla gated it off
// because its ML head could mis-report the previous route; this plugin records
// the exact tier it served, so the prev-route accuracy concern does not apply.
const STICKY_DEFAULT_ENABLED = true;
const STICKY_DEFAULT_MAX_USER_LEN = 200;

export type ProfileMatch = { key: string; profile: RouteProfile };

// The trigger check: does the session's requested model name a routing
// profile? Config keys may be written as "provider/modelId" or as the bare
// modelId (OpenClaw model ids themselves may contain "/"), so try the
// qualified form first, then the bare id.
export function matchProfile(
  profiles: Record<string, RouteProfile>,
  providerId: string | undefined,
  modelId: string | undefined,
): ProfileMatch | undefined {
  if (!modelId) {
    return undefined;
  }
  if (providerId) {
    const qualified = `${providerId}/${modelId}`;
    if (profiles[qualified]) {
      return { key: qualified, profile: profiles[qualified] };
    }
  }
  return profiles[modelId] ? { key: modelId, profile: profiles[modelId] } : undefined;
}

// Crude fallback thresholds. These are NOT the central rule layer — just a
// size/shape guess so a central outage still routes roughly by difficulty
// instead of pinning every turn to one model. Central owns the real policy;
// deliberately not a port of it (that would duplicate policy and drift).
const FALLBACK_HEAVY_CHARS = 12_000;
const FALLBACK_CODE_CHARS = 2_500;
const FALLBACK_SHORT_CHARS = 240;

// Central-outage fallback: pick a tier from raw size/shape only. The "normal"
// middle case defers to the profile's defaultTier (openclaw.json), so the one
// tunable knob for the fallback stays in config, not in code.
export function fallbackTier(message: string, attachmentCount: number, defaultTier: Tier): Tier {
  if (message.length >= FALLBACK_HEAVY_CHARS) {
    return "c3";
  }
  if (message.includes("```") || attachmentCount > 0 || message.length >= FALLBACK_CODE_CHARS) {
    return "c2";
  }
  if (message.length <= FALLBACK_SHORT_CHARS) {
    return "c0";
  }
  return defaultTier;
}

// heuristic.py _nearest_valid_tier: prefer the same tier, then walk up so an
// unconfigured tier never silently downgrades a turn, then walk down.
function nearestConfiguredTier(tier: Tier, tiers: RouteProfile["tiers"]): Tier | undefined {
  const start = TEXT_TIERS.indexOf(tier);
  for (const candidate of TEXT_TIERS.slice(start)) {
    if (tiers[candidate]?.model) {
      return candidate;
    }
  }
  for (const candidate of TEXT_TIERS.slice(0, start).reverse()) {
    if (tiers[candidate]?.model) {
      return candidate;
    }
  }
  return undefined;
}

export type ResolvedRoute = {
  /** Final tier after config resolution and sticky. */
  resolvedTier: Tier;
  target: TierTarget;
  /** Resolved tier the caller wanted before sticky held it back. */
  desiredTier: Tier;
  /** True when sticky blocked a downgrade to preserve the warm cache. */
  stuck: boolean;
};

/** Prior turn's served tier for one session — the sticky comparison basis. */
export type StickyContext = { lastTier: Tier; promptLen: number };

// OpenSquilla _apply_sticky_tier: on a short continuation turn, never route
// below the previous turn's tier. Only downgrades are blocked — an upgrade
// busts the cache too but the turn genuinely needs the stronger model.
function applySticky(
  desiredTier: Tier,
  sticky: StickyConfig,
  ctx: StickyContext | undefined,
): { tier: Tier; stuck: boolean } {
  if (!sticky.enabled || !ctx) {
    return { tier: desiredTier, stuck: false };
  }
  const isContinuation = ctx.promptLen <= sticky.maxUserLen;
  const isDowngrade = TEXT_TIERS.indexOf(ctx.lastTier) > TEXT_TIERS.indexOf(desiredTier);
  if (isContinuation && isDowngrade) {
    return { tier: ctx.lastTier, stuck: true };
  }
  return { tier: desiredTier, stuck: false };
}

// Turn an abstract tier (from central or the fallback) into a concrete model:
// snap to the profile's nearest configured tier, then apply sticky. A parsed
// profile always has at least one usable tier, so this only returns undefined
// on an impossible config.
export function resolveRoute(
  profile: RouteProfile,
  sticky: StickyConfig,
  tier: Tier,
  ctx?: StickyContext,
): ResolvedRoute | undefined {
  const desiredTier = nearestConfiguredTier(tier, profile.tiers);
  if (!desiredTier) {
    return undefined;
  }
  const { tier: resolvedTier, stuck } = applySticky(desiredTier, sticky, ctx);
  const target = profile.tiers[resolvedTier];
  if (!target) {
    return undefined;
  }
  return { resolvedTier, target, desiredTier, stuck };
}

function parseTierTarget(value: unknown): TierTarget | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || !record.model.trim()) {
    return undefined;
  }
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  return provider ? { model: record.model.trim(), provider } : { model: record.model.trim() };
}

function parseProfile(raw: unknown): RouteProfile | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const rawTiers = record.tiers;
  if (typeof rawTiers !== "object" || rawTiers === null) {
    return undefined;
  }
  const tiers: RouteProfile["tiers"] = {};
  for (const tier of TEXT_TIERS) {
    const target = parseTierTarget((rawTiers as Record<string, unknown>)[tier]);
    if (target) {
      tiers[tier] = target;
    }
  }
  if (Object.keys(tiers).length === 0) {
    return undefined;
  }
  const rawDefault = record.defaultTier;
  const defaultTier =
    typeof rawDefault === "string" && (TEXT_TIERS as readonly string[]).includes(rawDefault)
      ? (rawDefault as Tier)
      : "c1";
  return { tiers, defaultTier };
}

export function parseRouterConfig(
  pluginConfig: Record<string, unknown> | undefined,
): SquillaRouterConfig | undefined {
  const rawProfiles = pluginConfig?.profiles;
  if (typeof rawProfiles !== "object" || rawProfiles === null) {
    return undefined;
  }
  const profiles: Record<string, RouteProfile> = {};
  for (const [key, raw] of Object.entries(rawProfiles)) {
    const profile = parseProfile(raw);
    if (key.trim() && profile) {
      profiles[key.trim()] = profile;
    }
  }
  if (Object.keys(profiles).length === 0) {
    return undefined;
  }
  const central = parseCentralConfig(pluginConfig?.central);
  return {
    profiles,
    sticky: parseStickyConfig(pluginConfig?.sticky),
    ...(central ? { central } : {}),
  };
}

function parseCentralConfig(raw: unknown): CentralConfig | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!url) {
    return undefined;
  }
  const tenantId =
    typeof record.tenantId === "string" && record.tenantId.trim()
      ? record.tenantId.trim()
      : CENTRAL_DEFAULT_TENANT;
  const apiKey = typeof record.apiKey === "string" && record.apiKey ? record.apiKey : undefined;
  const timeoutMs =
    typeof record.timeoutMs === "number" &&
    Number.isFinite(record.timeoutMs) &&
    record.timeoutMs > 0
      ? Math.floor(record.timeoutMs)
      : CENTRAL_DEFAULT_TIMEOUT_MS;
  return { url, tenantId, ...(apiKey ? { apiKey } : {}), timeoutMs };
}

function parseStickyConfig(raw: unknown): StickyConfig {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const enabled = typeof record.enabled === "boolean" ? record.enabled : STICKY_DEFAULT_ENABLED;
  const maxUserLen =
    typeof record.maxUserLen === "number" &&
    Number.isFinite(record.maxUserLen) &&
    record.maxUserLen >= 0
      ? Math.floor(record.maxUserLen)
      : STICKY_DEFAULT_MAX_USER_LEN;
  return { enabled, maxUserLen };
}
