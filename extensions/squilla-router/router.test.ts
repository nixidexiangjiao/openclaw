import { describe, expect, it } from "vitest";
import {
  fallbackTier,
  parseRouterConfig,
  resolveRoute,
  type SquillaRouterConfig,
} from "./router.js";

const NO_STICKY = { enabled: false, maxUserLen: 200 };

const fullConfig: SquillaRouterConfig = {
  tiers: {
    c0: { model: "deepseek/deepseek-v4-flash" },
    c1: { model: "deepseek/deepseek-v4-pro" },
    c2: { model: "z-ai/glm-5.2" },
    c3: { model: "z-ai/glm-5.2", provider: "zai" },
  },
  defaultTier: "c1",
  sticky: NO_STICKY,
};

describe("fallbackTier (crude central-outage guess)", () => {
  it.each([
    { name: "short plain -> c0", message: "thanks", attachments: 0, tier: "c0" },
    {
      name: "normal prose -> defaultTier",
      message: "word ".repeat(120),
      attachments: 0,
      tier: "c1",
    },
    {
      name: "code fence -> c2",
      message: "fix this\n```ts\nconst a = 1;\n```",
      attachments: 0,
      tier: "c2",
    },
    { name: "long material -> c2", message: "a".repeat(3_000), attachments: 0, tier: "c2" },
    { name: "attachment -> c2", message: "summarize", attachments: 1, tier: "c2" },
    { name: "very long -> c3", message: "a".repeat(12_000), attachments: 0, tier: "c3" },
  ])("$name", ({ message, attachments, tier }) => {
    expect(fallbackTier(message, attachments, "c1")).toBe(tier);
  });

  it("routes the normal middle case to the operator's defaultTier", () => {
    // 300 chars: past short (240), well under the code/heavy thresholds.
    expect(fallbackTier("word ".repeat(60), 0, "c2")).toBe("c2");
  });
});

describe("resolveRoute", () => {
  it("maps a tier to its configured model", () => {
    const route = resolveRoute(fullConfig, "c2");
    expect(route?.resolvedTier).toBe("c2");
    expect(route?.target.model).toBe("z-ai/glm-5.2");
  });

  it("walks up when the requested tier is not configured", () => {
    const config: SquillaRouterConfig = {
      tiers: { c1: { model: "m1" }, c3: { model: "m3" } },
      defaultTier: "c1",
      sticky: NO_STICKY,
    };
    const route = resolveRoute(config, "c2");
    expect(route?.resolvedTier).toBe("c3");
    expect(route?.target.model).toBe("m3");
  });

  it("walks down only when nothing above is configured", () => {
    const config: SquillaRouterConfig = {
      tiers: { c0: { model: "m0" } },
      defaultTier: "c1",
      sticky: NO_STICKY,
    };
    const route = resolveRoute(config, "c3");
    expect(route?.resolvedTier).toBe("c0");
  });

  it("returns undefined when no tier is configured", () => {
    const route = resolveRoute({ tiers: {}, defaultTier: "c1", sticky: NO_STICKY }, "c1");
    expect(route).toBeUndefined();
  });
});

describe("sticky routing (KV-cache-aware)", () => {
  const stickyConfig: SquillaRouterConfig = {
    ...fullConfig,
    sticky: { enabled: true, maxUserLen: 200 },
  };

  it("blocks a downgrade on a short continuation turn", () => {
    // Prev turn served c2; a short follow-up would resolve to c0.
    const route = resolveRoute(stickyConfig, "c0", { lastTier: "c2", promptLen: 5 });
    expect(route?.desiredTier).toBe("c0");
    expect(route?.resolvedTier).toBe("c2");
    expect(route?.stuck).toBe(true);
  });

  it("allows a downgrade when the turn is long (not a continuation)", () => {
    const route = resolveRoute(stickyConfig, "c1", { lastTier: "c2", promptLen: 1_500 });
    expect(route?.resolvedTier).toBe("c1");
    expect(route?.stuck).toBe(false);
  });

  it("allows an upgrade even on a short turn (cache miss is worth it)", () => {
    const route = resolveRoute(stickyConfig, "c2", { lastTier: "c0", promptLen: 5 });
    expect(route?.resolvedTier).toBe("c2");
    expect(route?.stuck).toBe(false);
  });

  it("does nothing when sticky is disabled", () => {
    const route = resolveRoute(fullConfig, "c0", { lastTier: "c2", promptLen: 5 });
    expect(route?.resolvedTier).toBe("c0");
    expect(route?.stuck).toBe(false);
  });
});

describe("parseRouterConfig", () => {
  it("parses tiers, default, and sticky defaults", () => {
    const config = parseRouterConfig({
      defaultTier: "c2",
      tiers: { c0: { model: "a" }, c3: { model: "b", provider: "p" } },
    });
    expect(config).toEqual({
      defaultTier: "c2",
      tiers: { c0: { model: "a" }, c3: { model: "b", provider: "p" } },
      sticky: { enabled: true, maxUserLen: 200 },
    });
  });

  it("parses an explicit sticky override", () => {
    const config = parseRouterConfig({
      tiers: { c1: { model: "a" } },
      sticky: { enabled: false, maxUserLen: 50 },
    });
    expect(config?.sticky).toEqual({ enabled: false, maxUserLen: 50 });
  });

  it("parses the central block with defaults and drops it without a url", () => {
    const withCentral = parseRouterConfig({
      tiers: { c1: { model: "a" } },
      central: { url: "http://router-box:8710/v1/route", apiKey: "k" },
    });
    expect(withCentral?.central).toEqual({
      url: "http://router-box:8710/v1/route",
      tenantId: "default",
      apiKey: "k",
      timeoutMs: 2_000,
    });

    const explicit = parseRouterConfig({
      tiers: { c1: { model: "a" } },
      central: { url: "http://c", tenantId: "team-a", timeoutMs: 800 },
    });
    expect(explicit?.central).toMatchObject({ tenantId: "team-a", timeoutMs: 800 });

    const noUrl = parseRouterConfig({ tiers: { c1: { model: "a" } }, central: { apiKey: "k" } });
    expect(noUrl?.central).toBeUndefined();
  });

  it("rejects configs without any usable tier", () => {
    expect(parseRouterConfig(undefined)).toBeUndefined();
    expect(parseRouterConfig({ tiers: {} })).toBeUndefined();
    expect(parseRouterConfig({ tiers: { c1: { model: "  " } } })).toBeUndefined();
  });
});
