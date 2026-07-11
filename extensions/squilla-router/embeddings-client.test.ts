import { describe, expect, it } from "vitest";
import { embedTexts } from "./embeddings-client.js";
import type { MlRouterConfig } from "./router.js";

const config: MlRouterConfig = {
  url: "http://ml-box:8080/v1/embeddings",
  model: "bge-small-zh-v1.5",
  timeoutMs: 500,
  confidenceThreshold: 0.5,
};

function fetchStub(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
}

describe("embedTexts", () => {
  it("posts model+input and returns vectors in index order", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const result = await embedTexts(
      config,
      ["a", "b"],
      fetchStub((url, init) => {
        seen = { url, init };
        // Out-of-order data entries; index is authoritative.
        return Response.json({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        });
      }),
    );
    expect(result).toEqual({
      ok: true,
      vectors: [
        [1, 0],
        [0, 1],
      ],
    });
    expect(seen?.url).toBe(config.url);
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      model: "bge-small-zh-v1.5",
      input: ["a", "b"],
    });
  });

  it("sends a bearer token when apiKey is configured", async () => {
    let auth: string | undefined;
    await embedTexts(
      { ...config, apiKey: "k" },
      ["a"],
      fetchStub((_url, init) => {
        auth = (init.headers as Record<string, string>).authorization;
        return Response.json({ data: [{ embedding: [1] }] });
      }),
    );
    expect(auth).toBe("Bearer k");
  });

  it.each([
    ["HTTP error", () => new Response("nope", { status: 503 }), "HTTP 503"],
    ["non-JSON body", () => new Response("nope", { status: 200 }), "invalid JSON response"],
    [
      "wrong vector count",
      () => Response.json({ data: [{ embedding: [1] }, { embedding: [1] }] }),
      "unrecognized embeddings response shape",
    ],
    [
      "mismatched dimensions",
      () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
      "ok",
    ],
  ])("handles %s", async (_name, respond, expected) => {
    const result = await embedTexts(config, ["a"], fetchStub(respond));
    if (expected === "ok") {
      expect(result.ok).toBe(true);
    } else {
      expect(result).toEqual({ ok: false, reason: expected });
    }
  });

  it("rejects vectors with mismatched dimensions across texts", async () => {
    const result = await embedTexts(
      config,
      ["a", "b"],
      fetchStub(() =>
        Response.json({
          data: [
            { index: 0, embedding: [1, 2] },
            { index: 1, embedding: [1] },
          ],
        }),
      ),
    );
    expect(result).toEqual({ ok: false, reason: "unrecognized embeddings response shape" });
  });

  it("fails closed on network error and reports timeouts distinctly", async () => {
    const network = await embedTexts(config, ["a"], (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
    expect(network).toEqual({ ok: false, reason: "Error: ECONNREFUSED" });

    const timeoutError = new Error("aborted");
    timeoutError.name = "TimeoutError";
    const timeout = await embedTexts(config, ["a"], (() =>
      Promise.reject(timeoutError)) as unknown as typeof fetch);
    expect(timeout).toEqual({ ok: false, reason: "timeout after 500ms" });
  });
});
