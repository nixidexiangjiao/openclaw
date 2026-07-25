import { describe, expect, it } from "vitest";
import {
  availableTiers,
  matchProfile,
  parseRouterConfig,
  targetForTier,
  type RouteProfile,
} from "./router.js";

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

describe("availableTiers", () => {
  it("lists configured tiers in order so central only returns servable tiers", () => {
    expect(availableTiers(fullProfile)).toEqual(["c0", "c1", "c2", "c3"]);
    expect(
      availableTiers({ tiers: { c1: { model: "m" }, c3: { model: "m3" } }, defaultTier: "c1" }),
    ).toEqual(["c1", "c3"]);
  });
});

describe("targetForTier (pure lookup, no snapping)", () => {
  it("maps a tier to its configured model", () => {
    expect(targetForTier(fullProfile, "c2").model).toBe("z-ai/glm-5.2");
    expect(targetForTier(fullProfile, "c3").provider).toBe("zai");
  });

  it("falls back to defaultTier when central ignores availableTiers", () => {
    const profile: RouteProfile = { tiers: { c1: { model: "m1" } }, defaultTier: "c1" };
    expect(targetForTier(profile, "c3").model).toBe("m1");
  });
});

describe("parseRouterConfig", () => {
  it("parses profiles keyed by virtual id", () => {
    const config = parseRouterConfig({
      profiles: {
        "squilla/auto": {
          defaultTier: "c2",
          tiers: { c0: { model: "a" }, c2: { model: "b" }, c3: { model: "c", provider: "p" } },
        },
      },
    });
    expect(config?.profiles["squilla/auto"]).toEqual({
      defaultTier: "c2",
      tiers: { c0: { model: "a" }, c2: { model: "b" }, c3: { model: "c", provider: "p" } },
    });
  });

  it("pins defaultTier to a configured tier, preferring equal-or-stronger", () => {
    // Wanted c1 is unconfigured -> snap up to c2, never silently down to c0.
    const up = parseRouterConfig({
      profiles: { a: { defaultTier: "c1", tiers: { c0: { model: "x" }, c2: { model: "y" } } } },
    });
    expect(up?.profiles.a?.defaultTier).toBe("c2");

    // Nothing at or above c3 -> highest configured.
    const down = parseRouterConfig({
      profiles: { a: { defaultTier: "c3", tiers: { c0: { model: "x" }, c1: { model: "y" } } } },
    });
    expect(down?.profiles.a?.defaultTier).toBe("c1");

    // Unspecified defaults to c1 when configured.
    const implicit = parseRouterConfig({ profiles: { a: { tiers: { c1: { model: "y" } } } } });
    expect(implicit?.profiles.a?.defaultTier).toBe("c1");
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
  });

  it("parses the central block with defaults and drops it without a url", () => {
    const base = { profiles: { auto: { tiers: { c1: { model: "a" } } } } };
    expect(
      parseRouterConfig({ ...base, central: { url: "http://c:8710/v1/route", apiKey: "k" } })
        ?.central,
    ).toEqual({
      url: "http://c:8710/v1/route",
      tenantId: "default",
      apiKey: "k",
      timeoutMs: 2_000,
    });

    expect(
      parseRouterConfig({ ...base, central: { url: "http://c", tenantId: "t", timeoutMs: 800 } })
        ?.central,
    ).toMatchObject({ tenantId: "t", timeoutMs: 800 });

    expect(parseRouterConfig({ ...base, central: { apiKey: "k" } })?.central).toBeUndefined();
  });
});
