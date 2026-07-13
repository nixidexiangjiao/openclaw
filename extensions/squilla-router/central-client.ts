// Thin client for the central routing service. The plugin sends the message
// text (internal deployment; the service stores no plaintext) and receives an
// abstract tier plus a decisionId for tracing. Any failure means "use the crude
// local fallback instead", so this module never throws — it returns a closed
// ok/failed result with the reason.
//
// The wire contract is deliberately generic: the routing algorithm behind the
// service can be swapped (OpenSquilla today, something else tomorrow), so the
// client depends only on the abstract tier and the trace id. Anything richer
// rides in an opaque `meta` object the client does not read.

import { TEXT_TIERS, type CentralConfig, type Tier } from "./router.js";

export type CentralRoute = {
  tier: Tier;
  /** Correlate client logs/transcripts with the central decision trail. */
  decisionId: string;
};

export type CentralRouteResult = { ok: true; route: CentralRoute } | { ok: false; reason: string };

function parseRoute(body: unknown): CentralRoute | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const tier = record.tier;
  const decisionId = record.decisionId;
  // Generic contract: require only an abstract tier and a trace id; ignore
  // everything else (confidence, meta) so a different algorithm still parses.
  if (
    typeof tier !== "string" ||
    !(TEXT_TIERS as readonly string[]).includes(tier) ||
    typeof decisionId !== "string" ||
    !decisionId
  ) {
    return undefined;
  }
  return { tier: tier as Tier, decisionId };
}

export async function routeRemote(
  config: CentralConfig,
  request: { sessionKey: string; profile: string; message: string; attachmentCount: number },
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
        // Which virtual routing id triggered this turn, so central can keep
        // per-profile stats and later serve per-profile policy.
        profile: request.profile,
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
