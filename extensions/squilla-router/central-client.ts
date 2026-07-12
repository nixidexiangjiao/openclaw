// Thin client for the central routing service. The plugin sends the message
// text (internal deployment; the service stores no plaintext) and receives an
// abstract tier plus a decisionId for tracing. Any failure means "use the local
// heuristic instead", so this module never throws — it returns a closed
// ok/failed result with the reason.
//
// The wire contract is deliberately generic: the routing algorithm behind the
// service can be swapped (OpenSquilla today, something else tomorrow), so the
// client depends only on the abstract tier and the trace id. `confidence` is an
// optional generic score; any richer, algorithm-specific data rides in an
// opaque `meta` object the client does not decode.

import { TEXT_TIERS, type CentralConfig, type RouteDecision, type Tier } from "./router.js";

export type CentralRoute = {
  decision: RouteDecision;
  /** Correlate client logs/transcripts with the central decision trail. */
  decisionId: string;
};

export type CentralRouteResult = { ok: true; route: CentralRoute } | { ok: false; reason: string };

const ROUTE_CLASSES = ["R0", "R1", "R2", "R3"] as const;

// The client never reinterprets the central algorithm's opaque meta as local
// heuristic flags, so a central decision carries no flags of its own.
const NO_FLAGS: RouteDecision["flags"] = {
  highRisk: false,
  debug: false,
  repoArch: false,
  strictFormat: false,
  longContext: false,
};

// A central tier already survived the service's own gating, so we trust it at
// full confidence unless the response reports a lower score.
const DEFAULT_CONFIDENCE = 1;

function parseRoute(body: unknown): CentralRoute | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const tier = record.tier;
  const decisionId = record.decisionId;
  // Generic contract: require only an abstract tier and a trace id. Everything
  // else is optional so a different algorithm's response still parses.
  if (
    typeof tier !== "string" ||
    !(TEXT_TIERS as readonly string[]).includes(tier) ||
    typeof decisionId !== "string" ||
    !decisionId
  ) {
    return undefined;
  }
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? record.confidence
      : DEFAULT_CONFIDENCE;
  return {
    decisionId,
    decision: {
      band: "central",
      tier: tier as Tier,
      routeClass: ROUTE_CLASSES[TEXT_TIERS.indexOf(tier as Tier)],
      confidence,
      flags: NO_FLAGS,
      flagUpgraded: false,
    },
  };
}

export async function routeRemote(
  config: CentralConfig,
  request: { sessionKey: string; message: string; attachmentCount: number },
  fetchFn: typeof fetch = fetch,
): Promise<CentralRouteResult> {
  let response: Response;
  try {
    response = await fetchFn(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        tenantId: config.tenantId,
        sessionKey: request.sessionKey,
        message: request.message,
        attachmentCount: request.attachmentCount,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const reason = name === "TimeoutError" ? `timeout after ${config.timeoutMs}ms` : String(error);
    return { ok: false, reason };
  }
  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid JSON response" };
  }
  const route = parseRoute(body);
  if (!route) {
    return { ok: false, reason: "unrecognized response shape" };
  }
  return { ok: true, route };
}
