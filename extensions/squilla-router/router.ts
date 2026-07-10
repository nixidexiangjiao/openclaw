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

export type RoutingFlags = {
  highRisk: boolean;
  debug: boolean;
  repoArch: boolean;
  strictFormat: boolean;
  longContext: boolean;
};

export type RouteDecision = {
  band: HeuristicBand;
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

export type SquillaRouterConfig = {
  tiers: Partial<Record<Tier, TierTarget>>;
  defaultTier: Tier;
};

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

export type ResolvedRoute = RouteDecision & { resolvedTier: Tier; target: TierTarget };

export function resolveRoute(
  config: SquillaRouterConfig,
  decision: RouteDecision,
): ResolvedRoute | undefined {
  // Borderline confidence sits below OpenSquilla's confidence gate, which
  // flattens the classified tier back to the operator's default tier; a flag
  // upgrade is a strong signal and survives the gate.
  const gatedTier =
    decision.band === "borderline_plain" && !decision.flagUpgraded
      ? config.defaultTier
      : decision.tier;
  const resolvedTier = nearestConfiguredTier(gatedTier, config.tiers);
  if (!resolvedTier) {
    return undefined;
  }
  const target = config.tiers[resolvedTier];
  if (!target) {
    return undefined;
  }
  return { ...decision, resolvedTier, target };
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
  return { tiers, defaultTier };
}
