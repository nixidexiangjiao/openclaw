// Embedding-based semantic tier classification, fully in-plugin.
//
// The only external dependency is a generic embeddings endpoint (any
// OpenAI-compatible /v1/embeddings deployment — TEI, vLLM, Ollama, cloud). All
// routing logic runs here: each tier owns a set of anchor prompts; a turn is
// classified by cosine similarity of its embedding to the anchors, then the
// OpenSquilla post-processing rules (margin upgrade, under-routing safety)
// apply in probability space. This replaces the heavy in-process ML pipeline
// with one HTTP embedding call per turn plus microseconds of vector math.

import { TEXT_TIERS, type Tier } from "./router.js";

// Anchor prompts per tier, written from the tier intents in OpenSquilla's
// router.runtime.yaml tier_explanations (R0 trivial/ack, R1 routine bounded
// work, R2 debugging/multi-step analysis, R3 architecture/high-risk). zh+en
// mixed to match bge-small-zh-v1.5's bilingual training.
export const TIER_ANCHOR_TEXTS: Record<Tier, readonly string[]> = {
  c0: [
    "谢谢",
    "好的，收到",
    "thanks, that works",
    "ok sounds good",
    "把这句话改得礼貌一点",
    "这个词是什么意思",
    "translate this sentence to English",
    "今天是星期几",
  ],
  c1: [
    "帮我写一封请假邮件",
    "这段代码是做什么的",
    "给这个函数加上注释",
    "对比一下这两个方案的优缺点",
    "write a regex that matches email addresses",
    "总结一下这篇文章的要点",
    "how do I sort a list of objects in Python",
    "帮我把这段介绍润色得更正式",
  ],
  c2: [
    "这个报错是什么原因，帮我修复",
    "为什么这个测试在 CI 上失败，本地却能通过",
    "帮我实现一个带重试和超时控制的下载函数",
    "分析这段日志，找出请求变慢的根因",
    "debug this stack trace and explain the root cause",
    "设计这个功能的实现步骤并列出要改动的文件",
    "这个内存泄漏应该怎么排查",
    "refactor this module to remove the circular dependency",
  ],
  c3: [
    "设计一个跨区域容灾的部署架构",
    "评估从单体迁移到微服务的方案和风险",
    "怎么安全地把生产数据库迁移到新集群",
    "design a multi-tenant authorization architecture",
    "制定这个系统的分库分表和数据迁移方案",
    "评估这两种一致性协议在我们场景下的取舍",
    "规划一次零停机的大版本升级",
    "audit this design for security and scalability risks",
  ],
};

/** Anchor texts in the fixed order classifyEmbedding expects vectors back in. */
export function flatAnchorTexts(): string[] {
  return TEXT_TIERS.flatMap((tier) => [...TIER_ANCHOR_TEXTS[tier]]);
}

export type SemanticClassification = {
  tier: Tier;
  probabilities: Record<Tier, number>;
  /** Top-1 probability before margin/safety upgrades. */
  confidence: number;
  /** Top-1 minus top-2 probability. */
  margin: number;
  /**
   * Nearest anchors overall. Anchors are our own non-sensitive texts, so this
   * is the storable "what did the message look like" explanation for debug
   * trails that must not contain the message itself.
   */
  topAnchors: { text: string; similarity: number }[];
};

const TOP_ANCHORS_REPORTED = 3;

// Softmax temperature over cosine scores. bge cosines cluster in a narrow
// band (~0.4-0.9); a small temperature spreads them into usable probabilities.
const SCORE_TEMPERATURE = 0.05;
// Per tier, average the best K anchor similarities so one odd anchor cannot
// dominate and one good match is not diluted by seven unrelated anchors.
const TOP_K_ANCHORS = 2;
// OpenSquilla router.runtime.yaml thresholds.
const MARGIN_UPGRADE_THRESHOLD = 0.1;
const UNDER_ROUTING_SAFETY_THRESHOLD = 0.45;

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dot / denominator : 0;
}

function softmax(scores: readonly number[], temperature: number): number[] {
  const scaled = scores.map((score) => score / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

function meanTopK(values: number[], k: number): number {
  const top = [...values].sort((a, b) => b - a).slice(0, k);
  return top.reduce((sum, value) => sum + value, 0) / top.length;
}

/**
 * Classify a turn embedding against the anchor embeddings.
 *
 * `anchorVectors` must be the embeddings of `flatAnchorTexts()` in order —
 * the caller embeds those once per process and reuses them.
 */
export function classifyEmbedding(
  query: readonly number[],
  anchorVectors: readonly (readonly number[])[],
): SemanticClassification {
  const expected = flatAnchorTexts().length;
  if (anchorVectors.length !== expected) {
    throw new Error(`expected ${expected} anchor vectors, got ${anchorVectors.length}`);
  }

  const anchorTexts = flatAnchorTexts();
  const allSims = anchorVectors.map((anchor) => cosine(query, anchor));
  const tierScores: number[] = [];
  let offset = 0;
  for (const tier of TEXT_TIERS) {
    const count = TIER_ANCHOR_TEXTS[tier].length;
    tierScores.push(meanTopK(allSims.slice(offset, offset + count), TOP_K_ANCHORS));
    offset += count;
  }
  const topAnchors = allSims
    .map((similarity, idx) => ({ text: anchorTexts[idx], similarity }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_ANCHORS_REPORTED);

  const probs = softmax(tierScores, SCORE_TEMPERATURE);
  const ranked = probs.map((p, idx) => ({ p, idx })).sort((a, b) => b.p - a.p);
  const confidence = ranked[0].p;
  const margin = ranked[0].p - ranked[1].p;
  let tierIdx = ranked[0].idx;

  // OpenSquilla postprocess, in order: margin upgrade (an ambiguous call goes
  // one class up), then under-routing safety (heavy joint mass on c2+c3 means
  // the turn is not cheap, whatever won the argmax).
  if (margin < MARGIN_UPGRADE_THRESHOLD) {
    tierIdx = Math.min(tierIdx + 1, TEXT_TIERS.length - 1);
  }
  const heavyMass = probs[2] + probs[3];
  if (tierIdx < 2 && heavyMass > UNDER_ROUTING_SAFETY_THRESHOLD) {
    tierIdx = 2;
  }

  return {
    tier: TEXT_TIERS[tierIdx],
    probabilities: {
      c0: probs[0],
      c1: probs[1],
      c2: probs[2],
      c3: probs[3],
    },
    confidence,
    margin,
    topAnchors,
  };
}
