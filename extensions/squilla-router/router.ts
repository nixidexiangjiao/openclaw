// SquillaRouter plugin-local logic: routing-profile matching, tier→model
// lookup, and config parsing. That is ALL — the plugin is a pure pass-through.
//
// Every routing judgment (classification, KV-cache sticky, image handling,
// unavailable-tier snapping) lives in the central service. The plugin holds no
// heuristic of its own; when central is unreachable it serves the profile's
// configured defaultTier and nothing more.
//
// Trigger contract: routing runs ONLY when the session's selected model is one
// of the configured virtual routing ids (the `profiles` keys). Real models are
// never intercepted. A virtual id resolves to nothing outside this plugin, so
// once a profile matches the hook MUST return an override.

export const TEXT_TIERS = ["c0", "c1", "c2", "c3"] as const;
export type Tier = (typeof TEXT_TIERS)[number];

/** Where the served tier came from — for logs only. */
export type RouteSource = "central" | "default";

export type TierTarget = {
  model: string;
  provider?: string;
};

// One routing profile, keyed in config by the virtual model id that triggers
// it (e.g. "squilla/auto"). Each profile carries its own tier→model table so
// different virtual ids can route across different model sets.
//
// Invariant established by parseRouterConfig: `defaultTier` is always a key of
// `tiers`, so the central-unreachable path always resolves to a real model.
export type RouteProfile = {
  tiers: Partial<Record<Tier, TierTarget>>;
  defaultTier: Tier;
};

// Central routing service (services/squilla_central, deployed on your ML box).
// It owns every routing decision; the plugin only relays the turn and applies
// the tier it returns.
export type CentralConfig = {
  /** Central route endpoint, e.g. http://router-box:8710/v1/route */
  url: string;
  /** Tenant identifier the central service keys per-user data by. */
  tenantId: string;
  apiKey?: string;
  timeoutMs: number;
};

// All plugin config comes from openclaw.json. tokenhub distributes routing
// policy to the central service only, never to the plugin.
export type SquillaRouterConfig = {
  profiles: Record<string, RouteProfile>;
  central?: CentralConfig;
};

const CENTRAL_DEFAULT_TIMEOUT_MS = 2_000;
const CENTRAL_DEFAULT_TENANT = "default";

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

/** Tiers this profile can actually serve — sent to central so it only ever
 * returns a tier the plugin can map to a model. */
export function availableTiers(profile: RouteProfile): Tier[] {
  return TEXT_TIERS.filter((tier) => profile.tiers[tier]);
}

// Pure lookup. `tier` comes from central (already constrained to
// availableTiers) or is the profile's defaultTier; the `??` only catches a
// central that ignored availableTiers, and lands on the same tier the
// unreachable path uses.
export function targetForTier(profile: RouteProfile, tier: Tier): TierTarget {
  return profile.tiers[tier] ?? (profile.tiers[profile.defaultTier] as TierTarget);
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
  const configured = TEXT_TIERS.filter((tier) => tiers[tier]);
  if (configured.length === 0) {
    return undefined;
  }
  const rawDefault = record.defaultTier;
  const wanted =
    typeof rawDefault === "string" && (TEXT_TIERS as readonly string[]).includes(rawDefault)
      ? (rawDefault as Tier)
      : "c1";
  // Startup-only normalization (not a per-turn judgment): pin defaultTier to a
  // configured tier, preferring equal-or-stronger so a misconfigured default
  // never silently downgrades the central-unreachable path.
  const defaultTier =
    configured.find((tier) => TEXT_TIERS.indexOf(tier) >= TEXT_TIERS.indexOf(wanted)) ??
    configured[configured.length - 1];
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
  return { profiles, ...(central ? { central } : {}) };
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
