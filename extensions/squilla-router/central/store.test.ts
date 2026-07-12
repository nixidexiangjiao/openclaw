import { describe, expect, it } from "vitest";
import { CentralStore, type DecisionRecord } from "./store.js";

const NO_FLAGS = {
  highRisk: false,
  debug: false,
  repoArch: false,
  strictFormat: false,
  longContext: false,
};

function record(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    decisionId: "d-1",
    tenantId: "t1",
    sessionKey: "s1",
    tsMs: 1_000,
    band: "semantic",
    baseTier: "c0",
    gatedTier: "c0",
    finalTier: "c2",
    confidence: 0.9,
    margin: 0.4,
    probabilities: { c0: 0.7, c1: 0.1, c2: 0.15, c3: 0.05 },
    flags: { ...NO_FLAGS, highRisk: true },
    charLen: 12,
    attachmentCount: 0,
    topAnchors: [{ text: "谢谢", similarity: 0.8 }],
    policyVersion: "central-v1",
    latencyMs: 5,
    embedding: [0.1, 0.2],
    ...overrides,
  };
}

describe("CentralStore", () => {
  it("round-trips a decision with its trail and anchors", () => {
    const store = new CentralStore(":memory:");
    store.insertDecision(record({}));
    const loaded = store.getDecision("d-1");
    expect(loaded).toMatchObject({
      decisionId: "d-1",
      baseTier: "c0",
      gatedTier: "c0",
      finalTier: "c2",
      flags: { ...NO_FLAGS, highRisk: true },
      topAnchors: [{ text: "谢谢", similarity: 0.8 }],
      rating: null,
    });
    store.close();
  });

  it("lists a session's decisions newest first and scopes by tenant", () => {
    const store = new CentralStore(":memory:");
    store.insertDecision(record({ decisionId: "d-1", tsMs: 1 }));
    store.insertDecision(record({ decisionId: "d-2", tsMs: 2 }));
    store.insertDecision(record({ decisionId: "other", tenantId: "t2", tsMs: 3 }));
    const listed = store.listDecisions("t1", "s1", 10);
    expect(listed.map((entry) => entry.decisionId)).toEqual(["d-2", "d-1"]);
    expect(store.listDecisions("t2", undefined, 10)).toHaveLength(1);
    store.close();
  });

  it("records feedback with last-write-wins and rejects unknown decisions", () => {
    const store = new CentralStore(":memory:");
    store.insertDecision(record({}));
    expect(store.recordFeedback("d-1", "down", 5)).toBe(true);
    expect(store.recordFeedback("d-1", "up", 6)).toBe(true);
    expect(store.getDecision("d-1")?.rating).toBe("up");
    expect(store.recordFeedback("missing", "down", 7)).toBe(false);
    store.close();
  });

  it("aggregates per-tenant stats", () => {
    const store = new CentralStore(":memory:");
    store.insertDecision(record({ decisionId: "d-1", finalTier: "c2" }));
    store.insertDecision(record({ decisionId: "d-2", finalTier: "c0", band: "short_plain" }));
    store.recordFeedback("d-1", "down", 5);
    expect(store.stats("t1")).toEqual({
      tiers: { c2: 1, c0: 1 },
      bands: { semantic: 1, short_plain: 1 },
      ratings: { down: 1 },
    });
    store.close();
  });
});
