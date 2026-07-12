// Central SquillaRouter service: ALL routing intelligence lives here.
//
// The OpenClaw plugin is a thin client — it POSTs the message text and gets an
// abstract tier back. This service embeds the message (external OpenAI-
// compatible embeddings endpoint), classifies against the tier anchors, runs
// the confidence gate and flag upgrades, records a plaintext-free decision
// trail keyed by decisionId, and accepts feedback for later self-learning.
//
// Privacy contract: message text exists only in the request; it is never
// written to the store (see central/store.ts). Traceability instead comes from
// decisionId + the derived trail + nearest anchors; the client logs decisionId
// next to its own transcript, which is where the plaintext lives.
//
// Run (after bundling — see README "Central routing service"):
//   SQUILLA_EMBEDDINGS_URL=http://ml-box:8080/v1/embeddings \
//   SQUILLA_CENTRAL_TOKEN=<token> node squilla-central.mjs

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { embedTexts, type EmbeddingsConfig } from "../embeddings-client.js";
import {
  classifyTurn,
  semanticRouteDecision,
  TEXT_TIERS,
  type RouteDecision,
  type SemanticGate,
  type Tier,
} from "../router.js";
import { classifyEmbedding, flatAnchorTexts } from "../semantic.js";
import { CentralStore, type DecisionRecord } from "./store.js";

const MAX_MESSAGE_CHARS = 64_000;
const LIST_LIMIT_MAX = 100;
const RATINGS = new Set(["up", "down", "neutral"]);

export type CentralOptions = {
  store: CentralStore;
  embeddings: EmbeddingsConfig;
  gate: SemanticGate;
  policyVersion: string;
  /** Bearer token required on /v1/* when set. */
  token?: string;
  /** Injectable for tests; defaults to the real embeddings client. */
  embedFn?: typeof embedTexts;
  now?: () => number;
};

export type CentralRequest = {
  method: string;
  /** URL path, e.g. /v1/route */
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization?: string;
};

export type CentralResponse = { status: number; body: unknown };

function json(status: number, body: unknown): CentralResponse {
  return { status, body };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export class Central {
  private readonly embedFn: typeof embedTexts;
  private readonly now: () => number;
  private anchorVectors: number[][] | null = null;
  private anchorLoad: Promise<number[][] | null> | null = null;

  constructor(private readonly opts: CentralOptions) {
    this.embedFn = opts.embedFn ?? embedTexts;
    this.now = opts.now ?? Date.now;
  }

  // Anchors are compile-time constants; embed once per process. A failed load
  // retries on the next request instead of poisoning the cache.
  private async anchors(): Promise<number[][] | null> {
    if (this.anchorVectors) {
      return this.anchorVectors;
    }
    this.anchorLoad ??= this.embedFn(this.opts.embeddings, flatAnchorTexts()).then((result) => {
      this.anchorLoad = null;
      if (!result.ok) {
        return null;
      }
      this.anchorVectors = result.vectors;
      return this.anchorVectors;
    });
    return this.anchorLoad;
  }

  async handle(request: CentralRequest): Promise<CentralResponse> {
    if (request.path === "/healthz" && request.method === "GET") {
      return json(200, {
        status: "ok",
        policyVersion: this.opts.policyVersion,
        anchorsReady: this.anchorVectors !== null,
      });
    }
    if (this.opts.token) {
      const provided = (request.authorization ?? "").replace(/^[Bb]earer /, "");
      if (provided !== this.opts.token) {
        return json(401, { error: "unauthorized" });
      }
    }
    if (request.path === "/v1/route" && request.method === "POST") {
      return this.route(request.body);
    }
    if (request.path === "/v1/feedback" && request.method === "POST") {
      return this.feedback(request.body);
    }
    const decisionMatch = /^\/v1\/decisions\/([\w-]+)$/.exec(request.path);
    if (decisionMatch && request.method === "GET") {
      const decision = this.opts.store.getDecision(decisionMatch[1]);
      return decision ? json(200, decision) : json(404, { error: "unknown decisionId" });
    }
    if (request.path === "/v1/decisions" && request.method === "GET") {
      const tenantId = request.query.get("tenantId");
      if (!tenantId) {
        return json(400, { error: "tenantId is required" });
      }
      const limitRaw = Number(request.query.get("limit") ?? 20);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(Math.floor(limitRaw), LIST_LIMIT_MAX))
        : 20;
      return json(200, {
        decisions: this.opts.store.listDecisions(
          tenantId,
          request.query.get("sessionKey") ?? undefined,
          limit,
        ),
      });
    }
    if (request.path === "/v1/stats" && request.method === "GET") {
      const tenantId = request.query.get("tenantId");
      if (!tenantId) {
        return json(400, { error: "tenantId is required" });
      }
      return json(200, this.opts.store.stats(tenantId));
    }
    return json(404, { error: "not found" });
  }

  private async route(body: unknown): Promise<CentralResponse> {
    if (typeof body !== "object" || body === null) {
      return json(400, { error: "body must be a JSON object" });
    }
    const record = body as Record<string, unknown>;
    const tenantId = asString(record.tenantId);
    const sessionKey = asString(record.sessionKey) ?? "";
    const message = typeof record.message === "string" ? record.message : "";
    if (!tenantId) {
      return json(400, { error: "tenantId is required" });
    }
    if (!message.trim()) {
      return json(400, { error: "message must be a non-empty string" });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return json(413, { error: "message too large" });
    }
    const attachmentCount =
      typeof record.attachmentCount === "number" && record.attachmentCount > 0
        ? Math.floor(record.attachmentCount)
        : 0;

    const started = this.now();
    // Semantic first; central-side heuristic when embeddings are unavailable,
    // so the client still gets a routed answer whenever the service is up.
    let decision: RouteDecision;
    let baseTier: Tier;
    let gatedTier: Tier;
    let margin = 0;
    let probabilities: Record<Tier, number> = { c0: 0, c1: 0, c2: 0, c3: 0 };
    let topAnchors: { text: string; similarity: number }[] = [];
    let embedding: number[] | null = null;

    const anchorVectors = await this.anchors();
    const query = anchorVectors ? await this.embedFn(this.opts.embeddings, [message]) : null;
    if (anchorVectors && query?.ok) {
      const semantic = classifyEmbedding(query.vectors[0], anchorVectors);
      const semanticDecision = semanticRouteDecision(semantic, message, this.opts.gate);
      decision = semanticDecision;
      baseTier = semantic.tier;
      gatedTier = semanticDecision.gatedTier;
      margin = semantic.margin;
      probabilities = semantic.probabilities;
      topAnchors = semantic.topAnchors;
      embedding = query.vectors[0];
    } else {
      decision = classifyTurn(message, attachmentCount);
      baseTier = decision.tier;
      gatedTier = decision.tier;
    }

    const decisionRecord: DecisionRecord = {
      decisionId: randomUUID(),
      tenantId,
      sessionKey,
      tsMs: started,
      band: decision.band,
      baseTier,
      gatedTier,
      finalTier: decision.tier,
      confidence: decision.confidence,
      margin,
      probabilities,
      flags: decision.flags,
      charLen: message.length,
      attachmentCount,
      topAnchors,
      policyVersion: this.opts.policyVersion,
      latencyMs: this.now() - started,
      embedding,
    };
    this.opts.store.insertDecision(decisionRecord);

    return json(200, {
      decisionId: decisionRecord.decisionId,
      tier: decision.tier,
      routeClass: decision.routeClass,
      band: decision.band,
      confidence: decision.confidence,
      flags: decision.flags,
      flagUpgraded: decision.flagUpgraded,
      policyVersion: this.opts.policyVersion,
    });
  }

  private feedback(body: unknown): CentralResponse {
    if (typeof body !== "object" || body === null) {
      return json(400, { error: "body must be a JSON object" });
    }
    const record = body as Record<string, unknown>;
    const decisionId = asString(record.decisionId);
    const rating = asString(record.rating);
    if (!decisionId || !rating || !RATINGS.has(rating)) {
      return json(400, { error: "decisionId and rating (up|down|neutral) are required" });
    }
    const recorded = this.opts.store.recordFeedback(decisionId, rating, this.now());
    return recorded ? json(200, { ok: true }) : json(404, { error: "unknown decisionId" });
  }
}

// ---------------------------------------------------------------------------
// node:http shell (no framework, no deps)
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024;

export function serve(
  central: Central,
  host: string,
  port: number,
): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let body: unknown;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      central
        .handle({
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          body,
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        })
        .then((response) => {
          res.writeHead(response.status, { "content-type": "application/json" });
          res.end(JSON.stringify(response.body));
        })
        .catch(() => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        });
    });
  });
  server.listen(port, host);
  return server;
}

export function mainFromEnv(env: Record<string, string | undefined>): void {
  const embeddingsUrl = env.SQUILLA_EMBEDDINGS_URL;
  if (!embeddingsUrl) {
    throw new Error("SQUILLA_EMBEDDINGS_URL is required");
  }
  const defaultTierRaw = env.SQUILLA_DEFAULT_TIER ?? "c1";
  const defaultTier = (TEXT_TIERS as readonly string[]).includes(defaultTierRaw)
    ? (defaultTierRaw as Tier)
    : "c1";
  const central = new Central({
    store: new CentralStore(env.SQUILLA_DB_PATH ?? "squilla-central.sqlite"),
    embeddings: {
      url: embeddingsUrl,
      model: env.SQUILLA_EMBEDDINGS_MODEL ?? "bge-small-zh-v1.5",
      ...(env.SQUILLA_EMBEDDINGS_API_KEY ? { apiKey: env.SQUILLA_EMBEDDINGS_API_KEY } : {}),
      timeoutMs: Number(env.SQUILLA_EMBEDDINGS_TIMEOUT_MS ?? 2_000),
    },
    gate: {
      defaultTier,
      confidenceThreshold: Number(env.SQUILLA_CONFIDENCE_THRESHOLD ?? 0.5),
    },
    policyVersion: env.SQUILLA_POLICY_VERSION ?? "central-v1",
    ...(env.SQUILLA_CENTRAL_TOKEN ? { token: env.SQUILLA_CENTRAL_TOKEN } : {}),
  });
  const host = env.SQUILLA_HOST ?? "127.0.0.1";
  const port = Number(env.SQUILLA_PORT ?? 8710);
  serve(central, host, port);
  console.log(`squilla-central listening on http://${host}:${port}`);
}
