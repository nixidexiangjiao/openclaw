// Thin client for the central routing service. The plugin relays the turn
// (message text — internal deployment; the service stores no plaintext) and
// receives the abstract tier to serve plus a decisionId for tracing. Any
// failure means "serve the profile's defaultTier instead", so this module never
// throws — it returns a closed ok/failed result with the reason.
//
// The wire contract is deliberately generic: the routing algorithm behind the
// service can be swapped (OpenSquilla V4 today, something else tomorrow), so
// the client depends only on the abstract tier and the trace id. Anything
// richer rides in an opaque `meta` object the client does not read.
//
// `availableTiers` is part of the request so central returns a tier this
// profile can actually serve — the plugin does a pure lookup, never a snap.

import { TEXT_TIERS, type CentralConfig, type Tier } from "./router.js";

export type CentralRoute = {
  tier: Tier;
  /** Correlate client logs/transcripts with the central decision trail. */
  decisionId: string;
};

export type CentralRouteResult = { ok: true; route: CentralRoute } | { ok: false; reason: string };

export type CentralRouteRequest = {
  sessionKey: string;
  /** Virtual routing id that triggered this turn (central keys stats/policy on it). */
  profile: string;
  message: string;
  attachmentCount: number;
  /** Central owns vision handling; it decides what an image turn routes to. */
  hasImage: boolean;
  availableTiers: Tier[];
};

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
  request: CentralRouteRequest,
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
      body: JSON.stringify({ tenantId: config.tenantId, ...request }),
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
