import { describe, expect, it } from "vitest";
import type { EmbedResult } from "../embeddings-client.js";
import { TEXT_TIERS, type Tier } from "../router.js";
import { TIER_ANCHOR_TEXTS } from "../semantic.js";
import { Central, type CentralRequest } from "./server.js";
import { CentralStore } from "./store.js";

// Synthetic embedding space (see semantic.test.ts): anchors sit on their
// tier's axis; query text picks its axis via a marker prefix.
const TIER_AXIS: Record<Tier, number[]> = {
  c0: [1, 0, 0, 0],
  c1: [0, 1, 0, 0],
  c2: [0, 0, 1, 0],
  c3: [0, 0, 0, 1],
};

function axisFor(text: string): number[] {
  for (const tier of TEXT_TIERS) {
    if (text.startsWith(`${tier}:`) || TIER_ANCHOR_TEXTS[tier].includes(text)) {
      return [...TIER_AXIS[tier]];
    }
  }
  return [0.5, 0.5, 0.5, 0.5];
}

const embedStub = (async (_config, texts) => ({
  ok: true,
  vectors: texts.map((text) => axisFor(text)),
})) as (config: unknown, texts: readonly string[]) => Promise<EmbedResult>;

const embedFail = (async () => ({ ok: false, reason: "down" })) as typeof embedStub;

function makeCentral(overrides: { embedFn?: typeof embedStub; token?: string } = {}) {
  const store = new CentralStore(":memory:");
  const central = new Central({
    store,
    embeddings: { url: "http://stub", model: "stub", timeoutMs: 100 },
    gate: { defaultTier: "c1", confidenceThreshold: 0.5 },
    policyVersion: "test-v1",
    embedFn: (overrides.embedFn ?? embedStub) as never,
    now: () => 1_000,
    ...(overrides.token ? { token: overrides.token } : {}),
  });
  return { central, store };
}

function post(path: string, body: unknown, authorization?: string): CentralRequest {
  return {
    method: "POST",
    path,
    query: new URLSearchParams(),
    body,
    ...(authorization ? { authorization } : {}),
  };
}

function get(path: string, query = ""): CentralRequest {
  return { method: "GET", path, query: new URLSearchParams(query), body: undefined };
}

const routeBody = (message: string) => ({
  tenantId: "t1",
  sessionKey: "s1",
  message,
  attachmentCount: 0,
});

describe("Central /v1/route", () => {
  it("routes semantically and records a plaintext-free decision", async () => {
    const { central, store } = makeCentral();
    const message = "c3:設計一個跨區域容災架構-SECRET-PAYLOAD";
    const response = await central.handle(post("/v1/route", routeBody(message)));
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body.tier).toBe("c3");
    expect(body.band).toBe("semantic");
    expect(typeof body.decisionId).toBe("string");

    // Traceability without plaintext: the stored record carries the full
    // trail but no message column at all.
    const stored = store.getDecision(String(body.decisionId));
    expect(stored).toMatchObject({
      baseTier: "c3",
      finalTier: "c3",
      band: "semantic",
      charLen: message.length,
      policyVersion: "test-v1",
    });
    expect(stored?.topAnchors.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain("SECRET-PAYLOAD");
  });

  it("falls back to the heuristic when embeddings fail, still recording", async () => {
    const { central, store } = makeCentral({ embedFn: embedFail });
    const response = await central.handle(post("/v1/route", routeBody("谢谢")));
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body.tier).toBe("c0");
    expect(body.band).toBe("short_plain");
    expect(store.getDecision(String(body.decisionId))?.band).toBe("short_plain");
  });

  it("applies flag upgrades centrally", async () => {
    const { central } = makeCentral();
    const response = await central.handle(
      post("/v1/route", routeBody("c0:把这个删除了直接部署到生产")),
    );
    const body = response.body as Record<string, unknown>;
    expect(body.tier).toBe("c2");
    expect(body.flagUpgraded).toBe(true);
  });

  it("validates the request body", async () => {
    const { central } = makeCentral();
    expect((await central.handle(post("/v1/route", { sessionKey: "s" }))).status).toBe(400);
    expect((await central.handle(post("/v1/route", { tenantId: "t", message: "  " }))).status).toBe(
      400,
    );
  });
});

describe("Central trace endpoints", () => {
  it("serves the decision trail, session list, feedback, and stats", async () => {
    const { central } = makeCentral();
    const routed = (await central.handle(post("/v1/route", routeBody("c2:查一下这个报错"))))
      .body as Record<string, unknown>;
    const decisionId = String(routed.decisionId);

    const detail = await central.handle(get(`/v1/decisions/${decisionId}`));
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ decisionId, finalTier: "c2", rating: null });

    const feedback = await central.handle(post("/v1/feedback", { decisionId, rating: "down" }));
    expect(feedback.status).toBe(200);
    expect((await central.handle(get(`/v1/decisions/${decisionId}`))).body).toMatchObject({
      rating: "down",
    });

    const listed = await central.handle(get("/v1/decisions", "tenantId=t1&sessionKey=s1"));
    expect((listed.body as { decisions: unknown[] }).decisions).toHaveLength(1);

    const stats = await central.handle(get("/v1/stats", "tenantId=t1"));
    expect(stats.body).toMatchObject({ tiers: { c2: 1 }, ratings: { down: 1 } });
  });

  it("404s unknown decisions and rejects bad feedback", async () => {
    const { central } = makeCentral();
    expect((await central.handle(get("/v1/decisions/nope"))).status).toBe(404);
    expect(
      (await central.handle(post("/v1/feedback", { decisionId: "nope", rating: "down" }))).status,
    ).toBe(404);
    expect(
      (await central.handle(post("/v1/feedback", { decisionId: "x", rating: "meh" }))).status,
    ).toBe(400);
  });
});

describe("Central auth", () => {
  it("requires the bearer token on /v1/* but not /healthz", async () => {
    const { central } = makeCentral({ token: "secret" });
    expect((await central.handle(post("/v1/route", routeBody("hi")))).status).toBe(401);
    expect(
      (await central.handle(post("/v1/route", routeBody("c0:hi"), "Bearer secret"))).status,
    ).toBe(200);
    expect((await central.handle(get("/healthz"))).status).toBe(200);
  });
});
