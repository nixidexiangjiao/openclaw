// Minimal OpenAI-compatible embeddings client (POST {url} {model, input}).
// Works against TEI, vLLM, Ollama, or any hosted embeddings API. The caller
// treats any failure as "use the local heuristic instead", so this module
// never throws — it returns a closed ok/failed result with the reason.

import type { MlRouterConfig } from "./router.js";

export type EmbedResult = { ok: true; vectors: number[][] } | { ok: false; reason: string };

function parseVectors(body: unknown, expectedCount: number): number[][] | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    return undefined;
  }
  const vectors: number[][] = new Array(expectedCount);
  for (const [position, item] of data.entries()) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const embedding = record.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return undefined;
    }
    if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return undefined;
    }
    // OpenAI-compatible servers may return out of order; index is authoritative.
    const index = typeof record.index === "number" ? record.index : position;
    if (index < 0 || index >= expectedCount || vectors[index] !== undefined) {
      return undefined;
    }
    vectors[index] = embedding as number[];
  }
  const dimension = vectors[0]?.length;
  if (!vectors.every((vector) => vector !== undefined && vector.length === dimension)) {
    return undefined;
  }
  return vectors;
}

export async function embedTexts(
  config: MlRouterConfig,
  texts: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<EmbedResult> {
  let response: Response;
  try {
    response = await fetchFn(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: texts }),
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
  const vectors = parseVectors(body, texts.length);
  if (!vectors) {
    return { ok: false, reason: "unrecognized embeddings response shape" };
  }
  return { ok: true, vectors };
}
