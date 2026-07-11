// Per-session last-served tier, the basis for KV-cache-aware sticky routing.
//
// Bounded in-process cache: entries expire after `ttlMs` of inactivity and the
// map is capped at `maxSessions` (oldest-touched evicted first) so a
// long-running gateway with many sessions never grows without bound. State is
// intentionally in-memory only — a lost entry just means the next turn re-routes
// freely, which is safe (no user-visible data, only a missed cache-preservation
// opportunity).

import type { Tier } from "./router.js";

type Entry = { tier: Tier; touchedAt: number };

// TTL mirrors OpenSquilla's routing-history window (1800s): a session idle
// longer than this has almost certainly lost its provider-side cache anyway,
// so sticky no longer buys anything.
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 2_000;

export class SessionTierStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
    private readonly now: () => number = Date.now,
  ) {}

  get(sessionKey: string): Tier | undefined {
    const entry = this.entries.get(sessionKey);
    if (!entry) {
      return undefined;
    }
    if (this.now() - entry.touchedAt > this.ttlMs) {
      this.entries.delete(sessionKey);
      return undefined;
    }
    return entry.tier;
  }

  set(sessionKey: string, tier: Tier): void {
    // Re-insert so Map iteration order tracks recency; eviction pops the front.
    this.entries.delete(sessionKey);
    this.entries.set(sessionKey, { tier, touchedAt: this.now() });
    if (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
