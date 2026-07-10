import { describe, expect, it } from "vitest";
import {
  classifyTurn,
  computeFlags,
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

describe("classifyTurn bands", () => {
  const cases: Array<{
    name: string;
    message: string;
    attachments?: number;
    band: string;
    tier: string;
  }> = [
    { name: "trivial ack", message: "thanks", band: "short_plain", tier: "c0" },
    { name: "short zh ack", message: "好的，就这样吧", band: "short_plain", tier: "c0" },
    {
      name: "medium plain",
      message: "请把这段介绍改写得更正式一些。".repeat(20),
      band: "medium_plain",
      tier: "c1",
    },
    {
      name: "single code fence",
      message: "how do I fix this?\n```ts\nconst a = 1;\n```",
      band: "code_or_material",
      tier: "c2",
    },
    {
      name: "long material without fence",
      message: "a".repeat(3_000),
      band: "code_or_material",
      tier: "c2",
    },
    {
      name: "non-image attachment",
      message: "summarize this file",
      attachments: 1,
      band: "code_or_material",
      tier: "c2",
    },
    { name: "very long input", message: "a".repeat(12_000), band: "heavy", tier: "c3" },
    {
      name: "multi-file shape",
      message: "```a```\n```b```\n```c```",
      band: "heavy",
      tier: "c3",
    },
    {
      name: "borderline plain",
      message: "word ".repeat(300),
      band: "borderline_plain",
      tier: "c1",
    },
  ];
  it.each(cases)("$name -> $band/$tier", ({ message, attachments, band, tier }) => {
    const decision = classifyTurn(message, attachments ?? 0);
    expect(decision.band).toBe(band);
    expect(decision.tier).toBe(tier);
  });
});

describe("flag upgrades", () => {
  it("high_risk keyword upgrades a short turn to c2", () => {
    const decision = classifyTurn("把这个删除了直接部署到生产");
    expect(decision.band).toBe("short_plain");
    expect(decision.flags.highRisk).toBe(true);
    expect(decision.tier).toBe("c2");
    expect(decision.flagUpgraded).toBe(true);
  });

  it("debug alone does not upgrade", () => {
    const decision = classifyTurn("why does this error happen?");
    expect(decision.flags.debug).toBe(true);
    expect(decision.tier).toBe("c0");
    expect(decision.flagUpgraded).toBe(false);
  });

  it("debug + long_context upgrades to c2", () => {
    const paths = "src/a.ts src/b.ts and more prose here";
    const decision = classifyTurn(`this error confuses me: ${paths} ${"x".repeat(400)}`);
    expect(decision.flags.debug).toBe(true);
    expect(decision.flags.longContext).toBe(true);
    expect(decision.tier).toBe("c2");
  });

  it("repo_arch keyword floors at c1", () => {
    const decision = classifyTurn("怎么理解这个 monorepo?");
    expect(decision.flags.repoArch).toBe(true);
    expect(decision.tier).toBe("c1");
  });
});

describe("computeFlags structural detectors", () => {
  it("flags long_context on repeated log lines", () => {
    const log = "[ERROR] request failed with a very long diagnostic line repeated\n".repeat(30);
    expect(computeFlags(log).longContext).toBe(true);
  });

  it("flags debug on traceback pattern", () => {
    expect(computeFlags("Traceback (most recent call last):").debug).toBe(true);
  });
});

describe("resolveRoute", () => {
  it("routes borderline plain text to the default tier", () => {
    const decision = classifyTurn("word ".repeat(300));
    const route = resolveRoute(fullConfig, decision);
    expect(route?.resolvedTier).toBe("c1");
  });

  it("keeps flag-upgraded borderline turns on the upgraded tier", () => {
    const decision = classifyTurn(`production incident. ${"word ".repeat(300)}`);
    expect(decision.band).toBe("borderline_plain");
    const route = resolveRoute(fullConfig, decision);
    expect(route?.resolvedTier).toBe("c2");
  });

  it("walks up when the classified tier is not configured", () => {
    const config: SquillaRouterConfig = {
      tiers: { c1: { model: "m1" }, c3: { model: "m3" } },
      defaultTier: "c1",
      sticky: NO_STICKY,
    };
    const route = resolveRoute(config, classifyTurn("short\n```code```"));
    expect(route?.resolvedTier).toBe("c3");
    expect(route?.target.model).toBe("m3");
  });

  it("walks down only when nothing above is configured", () => {
    const config: SquillaRouterConfig = {
      tiers: { c0: { model: "m0" } },
      defaultTier: "c1",
      sticky: NO_STICKY,
    };
    const route = resolveRoute(config, classifyTurn("a".repeat(12_000)));
    expect(route?.resolvedTier).toBe("c0");
  });
});

describe("sticky routing (KV-cache-aware)", () => {
  const stickyConfig: SquillaRouterConfig = {
    ...fullConfig,
    sticky: { enabled: true, maxUserLen: 200 },
  };

  it("blocks a downgrade on a short continuation turn", () => {
    // Prev turn served c2; a short plain follow-up would classify to c0.
    const route = resolveRoute(stickyConfig, classifyTurn("go on"), {
      lastTier: "c2",
      promptLen: "go on".length,
    });
    expect(route?.desiredTier).toBe("c0");
    expect(route?.resolvedTier).toBe("c2");
    expect(route?.stuck).toBe(true);
  });

  it("allows a downgrade when the turn is long (not a continuation)", () => {
    const longPrompt = "word ".repeat(300); // borderline -> defaultTier c1
    const route = resolveRoute(stickyConfig, classifyTurn(longPrompt), {
      lastTier: "c2",
      promptLen: longPrompt.length,
    });
    expect(route?.resolvedTier).toBe("c1");
    expect(route?.stuck).toBe(false);
  });

  it("allows an upgrade even on a short turn (cache miss is worth it)", () => {
    const route = resolveRoute(stickyConfig, classifyTurn("删除生产库"), {
      lastTier: "c0",
      promptLen: "删除生产库".length,
    });
    expect(route?.resolvedTier).toBe("c2");
    expect(route?.stuck).toBe(false);
  });

  it("does nothing when sticky is disabled", () => {
    const route = resolveRoute(fullConfig, classifyTurn("go on"), {
      lastTier: "c2",
      promptLen: "go on".length,
    });
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

  it("rejects configs without any usable tier", () => {
    expect(parseRouterConfig(undefined)).toBeUndefined();
    expect(parseRouterConfig({ tiers: {} })).toBeUndefined();
    expect(parseRouterConfig({ tiers: { c1: { model: "  " } } })).toBeUndefined();
  });
});
