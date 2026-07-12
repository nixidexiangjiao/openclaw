// Thin client for the central routing service (central/server.ts). The plugin
// sends the message text (internal deployment; the service stores no
// plaintext) and receives an abstract tier plus a decisionId for tracing. Any
// failure means "use the local heuristic instead", so this module never
// throws — it returns a closed ok/failed result with the reason.

import { TEXT_TIERS, type CentralConfig, type RouteDecision, type Tier } from "./router.js";

export type CentralRoute = {
  decision: RouteDecision;
  /** Correlate client logs/transcripts with the central decision trail. */
  decisionId: string;
};

export type CentralRouteResult = { ok: true; route: CentralRoute } | { ok: false; reason: string };

const ROUTE_CLASSES = ["R0", "R1", "R2", "R3"] as const;

const FLAG_KEYS = ["highRisk", "debug", "repoArch", "strictFormat", "longContext"] as const;

function parseRoute(body: unknown): CentralRoute | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const tier = record.tier;
  const decisionId = record.decisionId;
  const confidence = record.confidence;
  if (
    typeof tier !== "string" ||
    !(TEXT_TIERS as readonly string[]).includes(tier) ||
    typeof decisionId !== "string" ||
    !decisionId ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence)
  ) {
    return undefined;
  }
  const rawFlags =
    typeof record.flags === "object" && record.flags !== null
      ? (record.flags as Record<string, unknown>)
      : {};
  const flags = Object.fromEntries(
    FLAG_KEYS.map((key) => [key, rawFlags[key] === true]),
  ) as RouteDecision["flags"];
  return {
    decisionId,
    decision: {
      band:
        typeof record.band === "string" && record.band
          ? (record.band as RouteDecision["band"])
          : "semantic",
      tier: tier as Tier,
      routeClass: ROUTE_CLASSES[TEXT_TIERS.indexOf(tier as Tier)],
      confidence,
      flags,
      flagUpgraded: record.flagUpgraded === true,
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
