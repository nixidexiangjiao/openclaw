import { describe, expect, it } from "vitest";
import { routeRemote } from "./central-client.js";
import type { CentralConfig } from "./router.js";

const config: CentralConfig = {
  url: "http://router-box:8710/v1/route",
  tenantId: "team-a",
  timeoutMs: 500,
};

// Generic wire response: tier + decisionId are the only fields the client
// reads; confidence/policyVersion/meta are ignored (opaque to the client).
const okBody = {
  decisionId: "d-1",
  tier: "c2",
  confidence: 0.83,
  policyVersion: "central-v1",
  meta: { routeClass: "R2", band: "anchor" },
};

function fetchStub(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
}

describe("routeRemote", () => {
  it("posts tenant/session/message and parses tier + decisionId", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const result = await routeRemote(
      config,
      {
        sessionKey: "s1",
        profile: "squilla/auto",
        message: "explain this traceback",
        attachmentCount: 0,
      },
      fetchStub((url, init) => {
        seen = { url, init };
        return Response.json(okBody);
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route).toEqual({ tier: "c2", decisionId: "d-1" });
    }
    expect(seen?.url).toBe(config.url);
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      tenantId: "team-a",
      sessionKey: "s1",
      profile: "squilla/auto",
      message: "explain this traceback",
      attachmentCount: 0,
    });
  });

  it("accepts a minimal response with only tier and decisionId", async () => {
    const result = await routeRemote(
      config,
      { sessionKey: "s1", profile: "squilla/auto", message: "hi", attachmentCount: 0 },
      fetchStub(() => Response.json({ tier: "c1", decisionId: "d-2" })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route).toEqual({ tier: "c1", decisionId: "d-2" });
    }
  });

  it("sends a bearer token when apiKey is configured", async () => {
    let auth: string | undefined;
    await routeRemote(
      { ...config, apiKey: "k" },
      { sessionKey: "s1", profile: "squilla/auto", message: "hi", attachmentCount: 0 },
      fetchStub((_url, init) => {
        auth = (init.headers as Record<string, string>).authorization;
        return Response.json(okBody);
      }),
    );
    expect(auth).toBe("Bearer k");
  });

  it.each([
    ["HTTP error", () => new Response("nope", { status: 503 }), "HTTP 503"],
    ["non-JSON body", () => new Response("nope", { status: 200 }), "invalid JSON response"],
    [
      "unknown tier",
      () => Response.json({ ...okBody, tier: "huge" }),
      "unrecognized response shape",
    ],
    [
      "missing decisionId",
      () => Response.json({ ...okBody, decisionId: "" }),
      "unrecognized response shape",
    ],
  ])("fails closed on %s", async (_name, respond, reason) => {
    const result = await routeRemote(
      config,
      { sessionKey: "s1", profile: "squilla/auto", message: "hi", attachmentCount: 0 },
      fetchStub(respond),
    );
    expect(result).toEqual({ ok: false, reason });
  });

  it("reports timeouts distinctly", async () => {
    const timeoutError = new Error("aborted");
    timeoutError.name = "TimeoutError";
    const result = await routeRemote(
      config,
      { sessionKey: "s1", profile: "squilla/auto", message: "hi", attachmentCount: 0 },
      (() => Promise.reject(timeoutError)) as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, reason: "timeout after 500ms" });
  });
});
