import { describe, expect, it } from "vitest";
import { classifyRemote } from "./ml-client.js";
import type { MlRouterConfig } from "./router.js";

const config: MlRouterConfig = {
  url: "http://ml-box:8701/v1/classify",
  timeoutMs: 500,
  confidenceThreshold: 0.5,
};

const okBody = {
  tier: "c2",
  routeClass: "R2",
  confidence: 0.83,
  difficulty: 1.7,
  margin: 0.4,
  source: "v4_phase3",
};

function fetchStub(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
}

describe("classifyRemote", () => {
  it("posts message and history, returns the parsed classification", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const result = await classifyRemote(
      config,
      "explain this traceback",
      [{ text: "earlier", routeClass: "R1", difficulty: 0.9 }],
      fetchStub((url, init) => {
        seen = { url, init };
        return Response.json(okBody);
      }),
    );
    expect(result).toEqual({
      ok: true,
      classification: {
        tier: "c2",
        routeClass: "R2",
        confidence: 0.83,
        difficulty: 1.7,
        margin: 0.4,
      },
    });
    expect(seen?.url).toBe(config.url);
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      message: "explain this traceback",
      history: [{ text: "earlier", routeClass: "R1", difficulty: 0.9 }],
    });
  });

  it("sends a bearer token when apiKey is configured", async () => {
    let auth: string | undefined;
    await classifyRemote(
      { ...config, apiKey: "k" },
      "hi",
      [],
      fetchStub((_url, init) => {
        auth = (init.headers as Record<string, string>).authorization;
        return Response.json(okBody);
      }),
    );
    expect(auth).toBe("Bearer k");
  });

  it("derives routeClass from tier when the response omits it", async () => {
    const result = await classifyRemote(
      config,
      "hi",
      [],
      fetchStub(() => Response.json({ tier: "c3", confidence: 0.9 })),
    );
    expect(result).toEqual({
      ok: true,
      classification: { tier: "c3", routeClass: "R3", confidence: 0.9 },
    });
  });

  it.each([
    ["HTTP error", () => new Response("nope", { status: 503 }), "HTTP 503"],
    ["non-JSON body", () => new Response("nope", { status: 200 }), "invalid JSON response"],
    [
      "unknown tier",
      () => Response.json({ tier: "huge", confidence: 1 }),
      "unrecognized response shape",
    ],
    ["missing confidence", () => Response.json({ tier: "c1" }), "unrecognized response shape"],
  ])("fails closed on %s", async (_name, respond, reason) => {
    const result = await classifyRemote(config, "hi", [], fetchStub(respond));
    expect(result).toEqual({ ok: false, reason });
  });

  it("fails closed when fetch rejects (network error)", async () => {
    const result = await classifyRemote(config, "hi", [], (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "Error: ECONNREFUSED" });
  });

  it("reports a timeout distinctly", async () => {
    const timeoutError = new Error("aborted");
    timeoutError.name = "TimeoutError";
    const result = await classifyRemote(config, "hi", [], (() =>
      Promise.reject(timeoutError)) as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "timeout after 500ms" });
  });
});
