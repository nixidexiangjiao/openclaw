// Per-session routing state: the last-served tier (KV-cache-aware sticky
// routing) plus a short window of route decisions forwarded to the remote ML
// service (its classifier is history-aware).
//
// Bounded in-process cache: entries expire after `ttlMs` of inactivity and the
// map is capped at `maxSessions` (oldest-touched evicted first) so a
// long-running gateway with many sessions never grows without bound. State is
// intentionally in-memory only — a lost entry just means the next turn re-routes
// freely, which is safe (no user-visible data, only a missed cache-preservation
// opportunity).

import type { MlHistoryEntry, Tier } from "./router.js";

export type SessionRouteState = {
  tier: Tier;
  history: MlHistoryEntry[];
};

type Entry = SessionRouteState & { touchedAt: number };

// TTL mirrors OpenSquilla's routing-history window (1800s): a session idle
// longer than this has almost certainly lost its provider-side cache anyway,
// so sticky no longer buys anything.
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 2_000;
// Same window OpenSquilla keeps (_MAX_ROUTING_HISTORY = 5).
const MAX_HISTORY_ENTRIES = 5;
// Bound per-entry memory; the ML service's BGE encoder truncates to ~510
// tokens anyway, so longer prompt tails add cost without adding signal.
const MAX_HISTORY_TEXT_CHARS = 2_000;

export class SessionTierStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
    private readonly now: () => number = Date.now,
  ) {}

  get(sessionKey: string): SessionRouteState | undefined {
    const entry = this.entries.get(sessionKey);
    if (!entry) {
      return undefined;
    }
    if (this.now() - entry.touchedAt > this.ttlMs) {
      this.entries.delete(sessionKey);
      return undefined;
    }
    return { tier: entry.tier, history: entry.history };
  }

  /** Record the turn's served tier and append its decision to the history window. */
  record(sessionKey: string, tier: Tier, historyEntry: MlHistoryEntry): void {
    const previous = this.entries.get(sessionKey);
    const truncated: MlHistoryEntry = {
      ...historyEntry,
      text: historyEntry.text.slice(0, MAX_HISTORY_TEXT_CHARS),
    };
    const history = [...(previous?.history ?? []), truncated].slice(-MAX_HISTORY_ENTRIES);
    // Re-insert so Map iteration order tracks recency; eviction pops the front.
    this.entries.delete(sessionKey);
    this.entries.set(sessionKey, { tier, history, touchedAt: this.now() });
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
