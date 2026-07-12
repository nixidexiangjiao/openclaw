// Central routing service storage (node:sqlite, zero deps).
//
// Privacy contract: the wire carries the message text, THIS STORE NEVER DOES.
// The schema has no message/text column at all — only derived data (lengths,
// flags, probabilities, decision trail, embedding vector, nearest anchors).
// Debugging correlates through decisionId: the client logs decisionId next to
// its own transcript, which is where the plaintext lives.

import { DatabaseSync } from "node:sqlite";
import type { RoutingFlags, Tier } from "../router.js";

export type DecisionRecord = {
  decisionId: string;
  tenantId: string;
  sessionKey: string;
  tsMs: number;
  /** "semantic" when embeddings served the turn, "heuristic" on fallback. */
  band: string;
  /** Decision trail: classifier tier -> confidence-gated tier -> final tier. */
  baseTier: Tier;
  gatedTier: Tier;
  finalTier: Tier;
  confidence: number;
  margin: number;
  probabilities: Record<Tier, number>;
  flags: RoutingFlags;
  charLen: number;
  attachmentCount: number;
  /** Nearest anchors — our own non-sensitive texts; the semantic explanation. */
  topAnchors: { text: string; similarity: number }[];
  policyVersion: string;
  latencyMs: number;
  /** Training fuel for later self-learning; derived data, not plaintext. */
  embedding: number[] | null;
};

export type DecisionSummary = Omit<DecisionRecord, "embedding"> & {
  rating: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  band TEXT NOT NULL,
  base_tier TEXT NOT NULL,
  gated_tier TEXT NOT NULL,
  final_tier TEXT NOT NULL,
  confidence REAL NOT NULL,
  margin REAL NOT NULL,
  probabilities TEXT NOT NULL,
  flags TEXT NOT NULL,
  char_len INTEGER NOT NULL,
  attachment_count INTEGER NOT NULL,
  top_anchors TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  embedding TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions (tenant_id, session_key, ts_ms);
CREATE TABLE IF NOT EXISTS feedback (
  decision_id TEXT PRIMARY KEY,
  rating TEXT NOT NULL,
  ts_ms INTEGER NOT NULL
);
`;

type DecisionRow = Record<string, string | number | bigint | null>;

function rowToSummary(row: DecisionRow, rating: string | null): DecisionSummary {
  return {
    decisionId: String(row.decision_id),
    tenantId: String(row.tenant_id),
    sessionKey: String(row.session_key),
    tsMs: Number(row.ts_ms),
    band: String(row.band),
    baseTier: String(row.base_tier) as Tier,
    gatedTier: String(row.gated_tier) as Tier,
    finalTier: String(row.final_tier) as Tier,
    confidence: Number(row.confidence),
    margin: Number(row.margin),
    probabilities: JSON.parse(String(row.probabilities)) as Record<Tier, number>,
    flags: JSON.parse(String(row.flags)) as RoutingFlags,
    charLen: Number(row.char_len),
    attachmentCount: Number(row.attachment_count),
    topAnchors: JSON.parse(String(row.top_anchors)) as { text: string; similarity: number }[],
    policyVersion: String(row.policy_version),
    latencyMs: Number(row.latency_ms),
    rating,
  };
}

export class CentralStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  insertDecision(record: DecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO decisions (
          decision_id, tenant_id, session_key, ts_ms, band,
          base_tier, gated_tier, final_tier, confidence, margin,
          probabilities, flags, char_len, attachment_count,
          top_anchors, policy_version, latency_ms, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.decisionId,
        record.tenantId,
        record.sessionKey,
        record.tsMs,
        record.band,
        record.baseTier,
        record.gatedTier,
        record.finalTier,
        record.confidence,
        record.margin,
        JSON.stringify(record.probabilities),
        JSON.stringify(record.flags),
        record.charLen,
        record.attachmentCount,
        JSON.stringify(record.topAnchors),
        record.policyVersion,
        record.latencyMs,
        record.embedding ? JSON.stringify(record.embedding) : null,
      );
  }

  getDecision(decisionId: string): DecisionSummary | undefined {
    const row = this.db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId) as
      | DecisionRow
      | undefined;
    if (!row) {
      return undefined;
    }
    const feedback = this.db
      .prepare("SELECT rating FROM feedback WHERE decision_id = ?")
      .get(decisionId) as DecisionRow | undefined;
    return rowToSummary(row, feedback ? String(feedback.rating) : null);
  }

  listDecisions(
    tenantId: string,
    sessionKey: string | undefined,
    limit: number,
  ): DecisionSummary[] {
    const rows = (
      sessionKey
        ? this.db
            .prepare(
              "SELECT * FROM decisions WHERE tenant_id = ? AND session_key = ? ORDER BY ts_ms DESC LIMIT ?",
            )
            .all(tenantId, sessionKey, limit)
        : this.db
            .prepare("SELECT * FROM decisions WHERE tenant_id = ? ORDER BY ts_ms DESC LIMIT ?")
            .all(tenantId, limit)
    ) as DecisionRow[];
    return rows.map((row) => {
      const feedback = this.db
        .prepare("SELECT rating FROM feedback WHERE decision_id = ?")
        .get(String(row.decision_id)) as DecisionRow | undefined;
      return rowToSummary(row, feedback ? String(feedback.rating) : null);
    });
  }

  /** Record a rating; last write wins so a rating can be revised later. */
  recordFeedback(decisionId: string, rating: string, tsMs: number): boolean {
    const exists = this.db
      .prepare("SELECT decision_id FROM decisions WHERE decision_id = ?")
      .get(decisionId);
    if (!exists) {
      return false;
    }
    this.db
      .prepare(
        "INSERT INTO feedback (decision_id, rating, ts_ms) VALUES (?, ?, ?) " +
          "ON CONFLICT(decision_id) DO UPDATE SET rating = excluded.rating, ts_ms = excluded.ts_ms",
      )
      .run(decisionId, rating, tsMs);
    return true;
  }

  /** Per-tenant aggregates for monitoring: tier/band distribution + feedback. */
  stats(tenantId: string): Record<string, unknown> {
    const tiers = this.db
      .prepare(
        "SELECT final_tier AS tier, COUNT(*) AS n FROM decisions WHERE tenant_id = ? GROUP BY final_tier",
      )
      .all(tenantId) as DecisionRow[];
    const bands = this.db
      .prepare("SELECT band, COUNT(*) AS n FROM decisions WHERE tenant_id = ? GROUP BY band")
      .all(tenantId) as DecisionRow[];
    const ratings = this.db
      .prepare(
        "SELECT f.rating AS rating, COUNT(*) AS n FROM feedback f " +
          "JOIN decisions d ON d.decision_id = f.decision_id WHERE d.tenant_id = ? GROUP BY f.rating",
      )
      .all(tenantId) as DecisionRow[];
    const toCounts = (rows: DecisionRow[], key: string) =>
      Object.fromEntries(rows.map((row) => [String(row[key]), Number(row.n)]));
    return {
      tiers: toCounts(tiers, "tier"),
      bands: toCounts(bands, "band"),
      ratings: toCounts(ratings, "rating"),
    };
  }

  close(): void {
    this.db.close();
  }
}
