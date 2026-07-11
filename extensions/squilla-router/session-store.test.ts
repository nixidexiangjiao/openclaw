import { describe, expect, it } from "vitest";
import { SessionTierStore } from "./session-store.js";

const entry = (text: string) => ({ text, routeClass: "R1" as const });

describe("SessionTierStore", () => {
  it("stores the last tier and accumulates history per session", () => {
    const store = new SessionTierStore();
    store.record("s1", "c2", entry("first"));
    store.record("s1", "c1", { text: "second", routeClass: "R2", difficulty: 1.2, margin: 0.3 });
    store.record("s2", "c0", entry("other"));

    const s1 = store.get("s1");
    expect(s1?.tier).toBe("c1");
    expect(s1?.history.map((h) => h.text)).toEqual(["first", "second"]);
    expect(s1?.history[1]).toMatchObject({ routeClass: "R2", difficulty: 1.2, margin: 0.3 });
    expect(store.get("s2")?.tier).toBe("c0");
    expect(store.get("missing")).toBeUndefined();
  });

  it("caps history at five entries and truncates long texts", () => {
    const store = new SessionTierStore();
    for (let i = 0; i < 7; i += 1) {
      store.record("s1", "c1", entry(`turn-${i}`));
    }
    store.record("s1", "c1", entry("x".repeat(5_000)));
    const history = store.get("s1")?.history ?? [];
    expect(history).toHaveLength(5);
    expect(history[0]?.text).toBe("turn-3");
    expect(history[4]?.text).toHaveLength(2_000);
  });

  it("expires entries after the TTL", () => {
    let now = 1_000;
    const store = new SessionTierStore(100, 2_000, () => now);
    store.record("s1", "c3", entry("t"));
    now = 1_099;
    expect(store.get("s1")?.tier).toBe("c3");
    now = 1_201; // > ttl since touchedAt
    expect(store.get("s1")).toBeUndefined();
  });

  it("refreshes touchedAt on record so an active session does not expire", () => {
    let now = 0;
    const store = new SessionTierStore(100, 2_000, () => now);
    store.record("s1", "c1", entry("a"));
    now = 80;
    store.record("s1", "c2", entry("b"));
    now = 160; // 160 - 80 < ttl
    expect(store.get("s1")?.tier).toBe("c2");
  });

  it("evicts the oldest session when over capacity", () => {
    const store = new SessionTierStore(60_000, 2, () => 0);
    store.record("a", "c0", entry("a"));
    store.record("b", "c1", entry("b"));
    store.record("c", "c2", entry("c")); // evicts "a"
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.tier).toBe("c1");
    expect(store.get("c")?.tier).toBe("c2");
    expect(store.size).toBe(2);
  });
});
