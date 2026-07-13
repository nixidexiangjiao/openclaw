// SquillaRouter plugin-local logic: tier→model resolution, KV-cache sticky, a
// crude central-outage fallback, and config parsing. All real routing
// intelligence (embedding, classification, gates) lives in the central service;
// this file holds only what must run in-process (the model override) plus what
// keeps routing usable when central is unreachable.

export const TEXT_TIERS = ["c0", "c1", "c2", "c3"] as const;
export type Tier = (typeof TEXT_TIERS)[number];

/** Where the chosen tier came from — for logs only. */
export type RouteSource = "central" | "fallback";

export type TierTarget = {
  model: string;
  provider?: string;
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
  tiers: Partial<Record<Tier, TierTarget>>;
  defaultTier: Tier;
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

// Crude fallback thresholds. These are NOT the central rule layer — just a
// size/shape guess so a central outage still routes roughly by difficulty
// instead of pinning every turn to one model. Central owns the real policy;
// deliberately not a port of it (that would duplicate policy and drift).
const FALLBACK_HEAVY_CHARS = 12_000;
const FALLBACK_CODE_CHARS = 2_500;
const FALLBACK_SHORT_CHARS = 240;

// Central-outage fallback: pick a tier from raw size/shape only. The "normal"
// middle case defers to the operator's defaultTier (openclaw.json), so the one
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
function nearestConfiguredTier(tier: Tier, tiers: SquillaRouterConfig["tiers"]): Tier | undefined {
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
// snap to the nearest configured tier, then apply sticky. Both inputs live in
// tier space, so the result is always a configured tier.
export function resolveRoute(
  config: SquillaRouterConfig,
  tier: Tier,
  sticky?: StickyContext,
): ResolvedRoute | undefined {
  const desiredTier = nearestConfiguredTier(tier, config.tiers);
  if (!desiredTier) {
    return undefined;
  }
  const { tier: resolvedTier, stuck } = applySticky(desiredTier, config.sticky, sticky);
  const target = config.tiers[resolvedTier];
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

export function parseRouterConfig(
  pluginConfig: Record<string, unknown> | undefined,
): SquillaRouterConfig | undefined {
  const rawTiers = pluginConfig?.tiers;
  if (typeof rawTiers !== "object" || rawTiers === null) {
    return undefined;
  }
  const tiers: SquillaRouterConfig["tiers"] = {};
  for (const tier of TEXT_TIERS) {
    const target = parseTierTarget((rawTiers as Record<string, unknown>)[tier]);
    if (target) {
      tiers[tier] = target;
    }
  }
  if (Object.keys(tiers).length === 0) {
    return undefined;
  }
  const rawDefault = pluginConfig?.defaultTier;
  const defaultTier =
    typeof rawDefault === "string" && (TEXT_TIERS as readonly string[]).includes(rawDefault)
      ? (rawDefault as Tier)
      : "c1";
  const central = parseCentralConfig(pluginConfig?.central);
  return {
    tiers,
    defaultTier,
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
