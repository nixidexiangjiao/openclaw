// SquillaRouter heuristic port (PoC): deterministic per-turn tier classification.
//
// Ported from OpenSquilla's dependency-free rule layer so OpenClaw can route each
// turn to the cheapest configured model that can plausibly serve it:
// - bands: opensquilla src/opensquilla/engine/routing/heuristic.py
// - flags: squilla_router v4 bundle flags.py + router.runtime.yaml flag_rules
// - flag upgrades: v4 bundle predictor.py _apply_flag_overrides
// Thresholds and keyword lists are kept byte-equivalent to the source so routing
// behavior stays comparable across both projects.

export const TEXT_TIERS = ["c0", "c1", "c2", "c3"] as const;
export type Tier = (typeof TEXT_TIERS)[number];
export type RouteClass = "R0" | "R1" | "R2" | "R3";

export type HeuristicBand =
  | "heavy"
  | "code_or_material"
  | "short_plain"
  | "medium_plain"
  | "borderline_plain";

/** Where a decision came from: a heuristic band, or the embedding classifier. */
export type RouteBand = HeuristicBand | "semantic";

export type RoutingFlags = {
  highRisk: boolean;
  debug: boolean;
  repoArch: boolean;
  strictFormat: boolean;
  longContext: boolean;
};

export type RouteDecision = {
  band: RouteBand;
  tier: Tier;
  routeClass: RouteClass;
  confidence: number;
  flags: RoutingFlags;
  flagUpgraded: boolean;
};

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

// Central routing service (central/server.ts, deployed on your ML box). The
// plugin sends the message and receives an abstract tier; every bit of routing
// intelligence — embedding, anchors, gates, flags — runs centrally. Any failure
// falls back to the local heuristic so routing never blocks on the service.
export type CentralConfig = {
  /** Central route endpoint, e.g. http://router-box:8710/v1/route */
  url: string;
  /** Tenant identifier the central service keys per-user data by. */
  tenantId: string;
  apiKey?: string;
  timeoutMs: number;
};

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

// Band thresholds (opensquilla engine/routing/heuristic.py).
const HEAVY_MIN_CHARS = 12_000;
const HEAVY_MIN_FENCED_BLOCKS = 3;
const CODE_OR_MATERIAL_MIN_CHARS = 2_500;
const SHORT_PLAIN_MAX_CHARS = 240;
const MEDIUM_PLAIN_MAX_CHARS = 1_200;

// Confident bands sit above OpenSquilla's 0.5 confidence gate; borderline sits
// below it, which we mirror here by routing borderline turns to defaultTier.
const CONFIDENT_HIGH_TIER_CONFIDENCE = 0.6;
const CONFIDENT_LOW_TIER_CONFIDENCE = 0.55;
const BORDERLINE_CONFIDENCE = 0.4;

// Flag rules (router.runtime.yaml flag_rules).
const HIGH_RISK_KEYWORDS = [
  "生产",
  "部署",
  "回滚",
  "迁移",
  "删除",
  "客户",
  "法务",
  "财务",
  "deploy",
  "rollback",
  "migration",
  "delete",
  "overwrite",
  "production",
  "customer-facing",
];
const DEBUG_KEYWORDS = [
  "error",
  "bug",
  "exception",
  "traceback",
  "failed",
  "root cause",
  "报错",
  "根因",
  "修复",
];
const DEBUG_PATTERNS = [/Traceback \(most recent/, /stderr:/, /FAILED/];
const REPO_ARCH_KEYWORDS = [
  "repo",
  "codebase",
  "monorepo",
  "architecture",
  "重构",
  "架构",
  "module",
  "dependency",
];
const STRICT_FORMAT_KEYWORDS = ["json", "yaml", "csv", "schema", "只返回", "不要解释", "按格式"];
const LONG_CONTEXT_CHAR_THRESHOLD = 6_000;
const LONG_CONTEXT_CODE_BLOCK_THRESHOLD = 1_500;
const LONG_CONTEXT_LOG_BLOCK_THRESHOLD = 1_500;
const LONG_CONTEXT_FILE_REF_THRESHOLD = 2;

// Structural detectors (v4 bundle flags.py).
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const LOG_BLOCK_RE =
  /(\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}.*\n){3,}|(^\[?(INFO|WARN|ERROR|DEBUG)\]?\s.*\n){3,}/gm;
const FILE_PATH_RE = /(?:^|[\s"'`(])([a-zA-Z_][\w.-]*\/[\w./-]+\.\w+)/gm;

const CLASS_BY_TIER: Record<Tier, RouteClass> = { c0: "R0", c1: "R1", c2: "R2", c3: "R3" };

function hasKeyword(textLower: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => textLower.includes(keyword));
}

function totalMatchLength(text: string, re: RegExp): number {
  let total = 0;
  for (const match of text.matchAll(re)) {
    total += match[0].length;
  }
  return total;
}

function countMatches(text: string, re: RegExp): number {
  let count = 0;
  for (const _ of text.matchAll(re)) {
    count += 1;
  }
  return count;
}

export function computeFlags(message: string): RoutingFlags {
  const textLower = message.toLowerCase();
  return {
    highRisk: hasKeyword(textLower, HIGH_RISK_KEYWORDS),
    debug:
      hasKeyword(textLower, DEBUG_KEYWORDS) ||
      DEBUG_PATTERNS.some((pattern) => pattern.test(message)),
    repoArch: hasKeyword(textLower, REPO_ARCH_KEYWORDS),
    strictFormat: hasKeyword(textLower, STRICT_FORMAT_KEYWORDS),
    longContext:
      message.length >= LONG_CONTEXT_CHAR_THRESHOLD ||
      totalMatchLength(message, CODE_BLOCK_RE) >= LONG_CONTEXT_CODE_BLOCK_THRESHOLD ||
      totalMatchLength(message, LOG_BLOCK_RE) >= LONG_CONTEXT_LOG_BLOCK_THRESHOLD ||
      countMatches(message, FILE_PATH_RE) >= LONG_CONTEXT_FILE_REF_THRESHOLD,
  };
}

function classifyBand(
  message: string,
  attachmentCount: number,
): { band: HeuristicBand; tier: Tier; confidence: number } {
  const charLen = message.length;
  const fencedBlocks = Math.floor(message.split("```").length / 2);
  if (charLen >= HEAVY_MIN_CHARS || fencedBlocks >= HEAVY_MIN_FENCED_BLOCKS) {
    return { band: "heavy", tier: "c3", confidence: CONFIDENT_HIGH_TIER_CONFIDENCE };
  }
  if (fencedBlocks > 0 || charLen >= CODE_OR_MATERIAL_MIN_CHARS || attachmentCount > 0) {
    return { band: "code_or_material", tier: "c2", confidence: CONFIDENT_HIGH_TIER_CONFIDENCE };
  }
  if (charLen <= SHORT_PLAIN_MAX_CHARS) {
    return { band: "short_plain", tier: "c0", confidence: CONFIDENT_LOW_TIER_CONFIDENCE };
  }
  if (charLen <= MEDIUM_PLAIN_MAX_CHARS) {
    return { band: "medium_plain", tier: "c1", confidence: CONFIDENT_LOW_TIER_CONFIDENCE };
  }
  return { band: "borderline_plain", tier: "c1", confidence: BORDERLINE_CONFIDENCE };
}

// predictor.py _apply_flag_overrides: upgrades only, never downgrades.
// A lone debug flag intentionally does not upgrade — only debug + long_context.
function applyFlagUpgrades(tier: Tier, flags: RoutingFlags): Tier {
  let idx = TEXT_TIERS.indexOf(tier);
  if (flags.highRisk) {
    idx = Math.max(idx, TEXT_TIERS.indexOf("c2"));
  }
  if (flags.debug && flags.longContext) {
    idx = Math.max(idx, TEXT_TIERS.indexOf("c2"));
  }
  if (flags.repoArch) {
    idx = Math.max(idx, TEXT_TIERS.indexOf("c1"));
  }
  return TEXT_TIERS[idx];
}

export function classifyTurn(message: string, attachmentCount = 0): RouteDecision {
  const { band, tier: bandTier, confidence } = classifyBand(message, attachmentCount);
  const flags = computeFlags(message);
  const tier = applyFlagUpgrades(bandTier, flags);
  return {
    band,
    tier,
    routeClass: CLASS_BY_TIER[tier],
    confidence,
    flags,
    flagUpgraded: tier !== bandTier,
  };
}

/** Confidence-gate parameters for the semantic pipeline (central-side config). */
export type SemanticGate = { defaultTier: Tier; confidenceThreshold: number };

/** RouteDecision plus the intermediate tier, kept for the decision trail. */
export type SemanticDecision = RouteDecision & { gatedTier: Tier };

// Turn an embedding-based semantic classification into a route decision.
// Two guards apply on top of the semantic tier, mirroring the heuristic
// path's semantics: the confidence gate flattens a low-confidence answer to
// defaultTier, and the flag upgrades still lift risk-signal turns afterwards
// (a gated tier with a "delete production" keyword must not stay cheap).
export function semanticRouteDecision(
  semantic: { tier: Tier; confidence: number },
  message: string,
  gate: SemanticGate,
): SemanticDecision {
  const gatedTier =
    semantic.confidence < gate.confidenceThreshold ? gate.defaultTier : semantic.tier;
  const flags = computeFlags(message);
  const tier = applyFlagUpgrades(gatedTier, flags);
  return {
    band: "semantic",
    tier,
    routeClass: CLASS_BY_TIER[tier],
    confidence: semantic.confidence,
    flags,
    flagUpgraded: tier !== gatedTier,
    gatedTier,
  };
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

export type ResolvedRoute = RouteDecision & {
  /** Final tier after the confidence gate, config resolution, and sticky. */
  resolvedTier: Tier;
  target: TierTarget;
  /** Resolved tier the classifier wanted before sticky held it back. */
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

export function resolveRoute(
  config: SquillaRouterConfig,
  decision: RouteDecision,
  sticky?: StickyContext,
): ResolvedRoute | undefined {
  // Borderline confidence sits below OpenSquilla's confidence gate, which
  // flattens the classified tier back to the operator's default tier; a flag
  // upgrade is a strong signal and survives the gate.
  const gatedTier =
    decision.band === "borderline_plain" && !decision.flagUpgraded
      ? config.defaultTier
      : decision.tier;
  const desiredTier = nearestConfiguredTier(gatedTier, config.tiers);
  if (!desiredTier) {
    return undefined;
  }
  // Sticky runs in resolved-tier space: both operands are configured tiers
  // (lastTier was served before, desiredTier just resolved), so the sticky
  // result is always a configured tier and needs no re-resolution.
  const { tier: resolvedTier, stuck } = applySticky(desiredTier, config.sticky, sticky);
  const target = config.tiers[resolvedTier];
  if (!target) {
    return undefined;
  }
  return { ...decision, resolvedTier, target, desiredTier, stuck };
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
