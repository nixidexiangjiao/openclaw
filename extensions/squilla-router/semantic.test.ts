import { describe, expect, it } from "vitest";
import { TEXT_TIERS, type Tier } from "./router.js";
import { classifyEmbedding, flatAnchorTexts, TIER_ANCHOR_TEXTS } from "./semantic.js";

// Synthetic 4-dim embedding space: each tier's anchors sit on their own axis,
// so a query vector's tier affinity is fully controlled by its components.
const TIER_AXIS: Record<Tier, number[]> = {
  c0: [1, 0, 0, 0],
  c1: [0, 1, 0, 0],
  c2: [0, 0, 1, 0],
  c3: [0, 0, 0, 1],
};

function syntheticAnchors(): number[][] {
  return TEXT_TIERS.flatMap((tier) => TIER_ANCHOR_TEXTS[tier].map(() => [...TIER_AXIS[tier]]));
}

describe("flatAnchorTexts", () => {
  it("flattens anchors in tier order", () => {
    const texts = flatAnchorTexts();
    expect(texts.length).toBe(
      TEXT_TIERS.reduce((sum, tier) => sum + TIER_ANCHOR_TEXTS[tier].length, 0),
    );
    expect(texts[0]).toBe(TIER_ANCHOR_TEXTS.c0[0]);
    expect(texts.at(-1)).toBe(TIER_ANCHOR_TEXTS.c3.at(-1));
  });
});

describe("classifyEmbedding", () => {
  it("picks the tier whose anchors the query resembles", () => {
    const anchors = syntheticAnchors();
    for (const tier of TEXT_TIERS) {
      const result = classifyEmbedding(TIER_AXIS[tier], anchors);
      expect(result.tier).toBe(tier);
      expect(result.confidence).toBeGreaterThan(0.9);
    }
  });

  it("applies the margin upgrade when the top two tiers are ambiguous", () => {
    // Equidistant between c1 and c2 -> tiny margin -> upgraded to c2.
    const result = classifyEmbedding([0, 0.7, 0.7, 0], syntheticAnchors());
    expect(result.margin).toBeLessThan(0.1);
    expect(result.tier).toBe("c2");
  });

  it("applies under-routing safety when heavy mass sits on c2+c3", () => {
    // c0 wins the argmax cleanly but c2+c3 jointly carry heavy probability.
    const result = classifyEmbedding([0.8, 0, 0.75, 0.74], syntheticAnchors());
    expect(result.probabilities.c2 + result.probabilities.c3).toBeGreaterThan(0.45);
    expect(result.tier).toBe("c2");
  });

  it("keeps probabilities normalized", () => {
    const result = classifyEmbedding([0.5, 0.4, 0.3, 0.2], syntheticAnchors());
    const total =
      result.probabilities.c0 +
      result.probabilities.c1 +
      result.probabilities.c2 +
      result.probabilities.c3;
    expect(total).toBeCloseTo(1, 6);
  });

  it("rejects a mismatched anchor set", () => {
    expect(() => classifyEmbedding([1, 0, 0, 0], [[1, 0, 0, 0]])).toThrow(/anchor vectors/);
  });
});
