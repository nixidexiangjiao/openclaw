import { describe, expect, it } from "vitest";
import { SessionTierStore } from "./session-store.js";

describe("SessionTierStore", () => {
  it("stores and returns the last tier per session", () => {
    const store = new SessionTierStore();
    store.set("s1", "c2");
    store.set("s2", "c0");
    expect(store.get("s1")).toBe("c2");
    expect(store.get("s2")).toBe("c0");
    expect(store.get("missing")).toBeUndefined();
  });

  it("expires entries after the TTL", () => {
    let now = 1_000;
    const store = new SessionTierStore(100, 2_000, () => now);
    store.set("s1", "c3");
    now = 1_099;
    expect(store.get("s1")).toBe("c3");
    now = 1_201; // > ttl since touchedAt
    expect(store.get("s1")).toBeUndefined();
  });

  it("refreshes touchedAt on set so an active session does not expire", () => {
    let now = 0;
    const store = new SessionTierStore(100, 2_000, () => now);
    store.set("s1", "c1");
    now = 80;
    store.set("s1", "c2");
    now = 160; // 160 - 80 < ttl
    expect(store.get("s1")).toBe("c2");
  });

  it("evicts the oldest session when over capacity", () => {
    const store = new SessionTierStore(60_000, 2, () => 0);
    store.set("a", "c0");
    store.set("b", "c1");
    store.set("c", "c2"); // evicts "a"
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBe("c1");
    expect(store.get("c")).toBe("c2");
    expect(store.size).toBe(2);
  });
});
