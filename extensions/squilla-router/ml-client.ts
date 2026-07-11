// HTTP client for an external SquillaRouter ML classification service
// (opensquilla squilla_router/http_service.py). The caller treats any failure
// as "use the local heuristic instead", so this module never throws — it
// returns a closed ok/failed result with the reason for the log line.

import {
  TEXT_TIERS,
  type MlClassification,
  type MlHistoryEntry,
  type MlRouterConfig,
  type RouteClass,
  type Tier,
} from "./router.js";

export type MlClassifyResult =
  | { ok: true; classification: MlClassification }
  | { ok: false; reason: string };

const ROUTE_CLASSES = ["R0", "R1", "R2", "R3"] as const;

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseClassification(body: unknown): MlClassification | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const tier = record.tier;
  if (typeof tier !== "string" || !(TEXT_TIERS as readonly string[]).includes(tier)) {
    return undefined;
  }
  const confidence = asFiniteNumber(record.confidence);
  if (confidence === undefined) {
    return undefined;
  }
  const routeClass =
    typeof record.routeClass === "string" &&
    (ROUTE_CLASSES as readonly string[]).includes(record.routeClass)
      ? (record.routeClass as RouteClass)
      : ROUTE_CLASSES[TEXT_TIERS.indexOf(tier as Tier)];
  const difficulty = asFiniteNumber(record.difficulty);
  const margin = asFiniteNumber(record.margin);
  return {
    tier: tier as Tier,
    routeClass,
    confidence,
    ...(difficulty !== undefined ? { difficulty } : {}),
    ...(margin !== undefined ? { margin } : {}),
  };
}

export async function classifyRemote(
  config: MlRouterConfig,
  message: string,
  history: readonly MlHistoryEntry[],
  fetchFn: typeof fetch = fetch,
): Promise<MlClassifyResult> {
  let response: Response;
  try {
    response = await fetchFn(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ message, history }),
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
  const classification = parseClassification(body);
  if (!classification) {
    return { ok: false, reason: "unrecognized response shape" };
  }
  return { ok: true, classification };
}
