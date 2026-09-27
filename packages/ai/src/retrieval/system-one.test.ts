/** The System One client: the request a probe makes and how a failure reads. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CFG } from "../test-helpers.js";
import { probeSystemOne } from "./system-one.js";

afterEach(() => vi.unstubAllGlobals());

describe("probeSystemOne", () => {
  it("answers null when the model answers its one question", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    expect(await probeSystemOne(CFG.rerank)).toBeNull();
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://rerank.example.test/v1/systemone");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "jev-latest", questions: { ok: { type: "noul" } } });
  });

  it("answers with the refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid api key", { status: 401 })));
    expect(await probeSystemOne(CFG.rerank)).toContain("invalid api key");
  });
});
