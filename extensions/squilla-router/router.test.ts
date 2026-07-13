import { describe, expect, it } from "vitest";
import {
  fallbackTier,
  matchProfile,
  parseRouterConfig,
  resolveRoute,
  type RouteProfile,
  type StickyConfig,
} from "./router.js";

const NO_STICKY: StickyConfig = { enabled: false, maxUserLen: 200 };
const STICKY: StickyConfig = { enabled: true, maxUserLen: 200 };

const fullProfile: RouteProfile = {
  tiers: {
    c0: { model: "deepseek/deepseek-v4-flash" },
    c1: { model: "deepseek/deepseek-v4-pro" },
    c2: { model: "z-ai/glm-5.2" },
    c3: { model: "z-ai/glm-5.2", provider: "zai" },
  },
  defaultTier: "c1",
};

describe("matchProfile (virtual-id trigger gate)", () => {
  const profiles = { "squilla/auto": fullProfile, "auto-max": fullProfile };

  it("matches provider/modelId first, then the bare modelId", () => {
    expect(matchProfile(profiles, "squilla", "auto")?.key).toBe("squilla/auto");
    expect(matchProfile(profiles, "whatever", "auto-max")?.key).toBe("auto-max");
    // Model ids may already carry a "/" prefix; the bare form still matches.
    expect(matchProfile(profiles, undefined, "squilla/auto")?.key).toBe("squilla/auto");
  });

  it("does not match real models", () => {
    expect(matchProfile(profiles, "zai", "glm-5.2")).toBeUndefined();
    expect(matchProfile(profiles, undefined, undefined)).toBeUndefined();
  });
});

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

  it("routes the normal middle case to the profile's defaultTier", () => {
    // 300 chars: past short (240), well under the code/heavy thresholds.
    expect(fallbackTier("word ".repeat(60), 0, "c2")).toBe("c2");
  });
});

describe("resolveRoute", () => {
  it("maps a tier to its configured model", () => {
    const route = resolveRoute(fullProfile, NO_STICKY, "c2");
    expect(route?.resolvedTier).toBe("c2");
    expect(route?.target.model).toBe("z-ai/glm-5.2");
  });

  it("walks up when the requested tier is not configured", () => {
    const profile: RouteProfile = {
      tiers: { c1: { model: "m1" }, c3: { model: "m3" } },
      defaultTier: "c1",
    };
    const route = resolveRoute(profile, NO_STICKY, "c2");
    expect(route?.resolvedTier).toBe("c3");
    expect(route?.target.model).toBe("m3");
  });

  it("walks down only when nothing above is configured", () => {
    const profile: RouteProfile = { tiers: { c0: { model: "m0" } }, defaultTier: "c1" };
    const route = resolveRoute(profile, NO_STICKY, "c3");
    expect(route?.resolvedTier).toBe("c0");
  });

  it("returns undefined when no tier is configured", () => {
    const route = resolveRoute({ tiers: {}, defaultTier: "c1" }, NO_STICKY, "c1");
    expect(route).toBeUndefined();
  });
});

describe("sticky routing (KV-cache-aware)", () => {
  it("blocks a downgrade on a short continuation turn", () => {
    // Prev turn served c2; a short follow-up would resolve to c0.
    const route = resolveRoute(fullProfile, STICKY, "c0", { lastTier: "c2", promptLen: 5 });
    expect(route?.desiredTier).toBe("c0");
    expect(route?.resolvedTier).toBe("c2");
    expect(route?.stuck).toBe(true);
  });

  it("allows a downgrade when the turn is long (not a continuation)", () => {
    const route = resolveRoute(fullProfile, STICKY, "c1", { lastTier: "c2", promptLen: 1_500 });
    expect(route?.resolvedTier).toBe("c1");
    expect(route?.stuck).toBe(false);
  });

  it("allows an upgrade even on a short turn (cache miss is worth it)", () => {
    const route = resolveRoute(fullProfile, STICKY, "c2", { lastTier: "c0", promptLen: 5 });
    expect(route?.resolvedTier).toBe("c2");
    expect(route?.stuck).toBe(false);
  });

  it("does nothing when sticky is disabled", () => {
    const route = resolveRoute(fullProfile, NO_STICKY, "c0", { lastTier: "c2", promptLen: 5 });
    expect(route?.resolvedTier).toBe("c0");
    expect(route?.stuck).toBe(false);
  });
});

describe("parseRouterConfig", () => {
  it("parses profiles keyed by virtual id, with per-profile defaults", () => {
    const config = parseRouterConfig({
      profiles: {
        "squilla/auto": {
          defaultTier: "c2",
          tiers: { c0: { model: "a" }, c3: { model: "b", provider: "p" } },
        },
        "squilla/auto-max": { tiers: { c3: { model: "m3" } } },
      },
    });
    expect(config?.profiles["squilla/auto"]).toEqual({
      defaultTier: "c2",
      tiers: { c0: { model: "a" }, c3: { model: "b", provider: "p" } },
    });
    // defaultTier defaults to c1 per profile.
    expect(config?.profiles["squilla/auto-max"]?.defaultTier).toBe("c1");
    expect(config?.sticky).toEqual({ enabled: true, maxUserLen: 200 });
  });

  it("drops profiles without any usable tier and rejects empty configs", () => {
    const config = parseRouterConfig({
      profiles: {
        ok: { tiers: { c1: { model: "m" } } },
        broken: { tiers: { c1: { model: "  " } } },
      },
    });
    expect(Object.keys(config?.profiles ?? {})).toEqual(["ok"]);

    expect(parseRouterConfig(undefined)).toBeUndefined();
    expect(parseRouterConfig({ profiles: {} })).toBeUndefined();
    expect(
      parseRouterConfig({ profiles: { bad: { tiers: { c1: { model: " " } } } } }),
    ).toBeUndefined();
  });

  it("parses an explicit sticky override", () => {
    const config = parseRouterConfig({
      profiles: { auto: { tiers: { c1: { model: "a" } } } },
      sticky: { enabled: false, maxUserLen: 50 },
    });
    expect(config?.sticky).toEqual({ enabled: false, maxUserLen: 50 });
  });

  it("parses the central block with defaults and drops it without a url", () => {
    const base = { profiles: { auto: { tiers: { c1: { model: "a" } } } } };
    const withCentral = parseRouterConfig({
      ...base,
      central: { url: "http://router-box:8710/v1/route", apiKey: "k" },
    });
    expect(withCentral?.central).toEqual({
      url: "http://router-box:8710/v1/route",
      tenantId: "default",
      apiKey: "k",
      timeoutMs: 2_000,
    });

    const explicit = parseRouterConfig({
      ...base,
      central: { url: "http://c", tenantId: "team-a", timeoutMs: 800 },
    });
    expect(explicit?.central).toMatchObject({ tenantId: "team-a", timeoutMs: 800 });

    const noUrl = parseRouterConfig({ ...base, central: { apiKey: "k" } });
    expect(noUrl?.central).toBeUndefined();
  });
});
