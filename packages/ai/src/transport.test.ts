/**
 * Retry / backoff classification shared by the non-Pi clients: transient failures
 * (429, 5xx, network) retry with bounded attempts; other 4xx fail fast. Exercised
 * through embed() because it is the simplest caller with a single request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embed } from "./retrieval/embed.js";
import { AiError, fetchWithRetry, joinUrl } from "./transport.js";
import { CFG } from "./test-helpers.js";

const OK = JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 1024 }, () => 0) }], usage: { prompt_tokens: 3 } });

describe("retry / backoff (AiError classification)", () => {
  // Make backoff instant so retries don't add real wall-clock to the suite.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Run an async fn while auto-advancing fake timers so setTimeout-based backoff resolves. */
  async function runWithTimers<T>(p: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return p;
  }

  it("retries a 429 and succeeds on a later attempt", async () => {
    let n = 0;
    const fn = vi.fn(() => {
      n++;
      return Promise.resolve(n < 3 ? new Response("slow down", { status: 429 }) : new Response(OK, { status: 200 }));
    });
    vi.stubGlobal("fetch", fn);
    const res = await runWithTimers(embed(CFG, ["x"]));
    expect(res.embeddings[0]).toHaveLength(1024);
    expect(fn).toHaveBeenCalledTimes(3); // two 429s + one success
  });

  it("retries 5xx then gives up as a retryable AiError after exhausting attempts", async () => {
    const fn = vi.fn(() => Promise.resolve(new Response("boom", { status: 503 })));
    vi.stubGlobal("fetch", fn);
    const err = await runWithTimers(embed(CFG, ["x"]).catch((e) => e));
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).status).toBe(503);
    expect((err as AiError).retryable).toBe(true);
    expect(fn).toHaveBeenCalledTimes(4); // default attempts
  });

  it("does NOT retry a 4xx (fail-fast, terminal)", async () => {
    const fn = vi.fn(() => Promise.resolve(new Response("bad input", { status: 400 })));
    vi.stubGlobal("fetch", fn);
    const err = await runWithTimers(embed(CFG, ["x"]).catch((e) => e));
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).retryable).toBe(false);
    expect((err as AiError).message).toMatch(/embeddings 400: bad input/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a network throw (no response)", async () => {
    let n = 0;
    const fn = vi.fn(() => {
      n++;
      if (n === 1) return Promise.reject(new Error("ECONNRESET"));
      return Promise.resolve(new Response(OK, { status: 200 }));
    });
    vi.stubGlobal("fetch", fn);
    const res = await runWithTimers(embed(CFG, ["x"]));
    expect(res.embeddings).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("joinUrl", () => {
  it("joins without doubling or dropping the slash", () => {
    expect(joinUrl("https://a/v1", "/embeddings")).toBe("https://a/v1/embeddings");
    expect(joinUrl("https://a/v1/", "embeddings")).toBe("https://a/v1/embeddings");
    expect(joinUrl("https://a/v1//", "//embeddings")).toBe("https://a/v1/embeddings");
  });
});

describe("fetchWithRetry — the caller's signal", () => {
  afterEach(() => vi.useRealTimers());

  it("ends the wait for headers and is rethrown as-is, with no retry", async () => {
    const ctrl = new AbortController();
    // Behaves like fetch: settles only when the signal it was handed aborts.
    const doFetch = vi.fn(
      (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    );
    const p = fetchWithRetry("x", doFetch, { signal: ctrl.signal });
    ctrl.abort(new Error("stop"));
    // Not an AiError: a cancel is not a failure, and the reason comes back untouched.
    await expect(p).rejects.toThrow("stop");
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("stays wired over the body, so a stop mid-stream ends the read", async () => {
    const ctrl = new AbortController();
    const doFetch = vi.fn(
      (signal: AbortSignal) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode("first\n"));
                signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
              },
            }),
            { status: 200 },
          ),
        ),
    );
    const res = await fetchWithRetry("x", doFetch, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
    ctrl.abort(new Error("stop"));
    await expect(reader.read()).rejects.toThrow("stop");
  });

  it("cuts a backoff sleep short and makes no further attempt", async () => {
    const ctrl = new AbortController();
    const doFetch = vi.fn(async () => new Response("busy", { status: 429 }));
    const p = fetchWithRetry("x", doFetch, { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 5)); // inside the first backoff (>= 125ms)
    ctrl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("does not change the retry path when no signal is given", async () => {
    vi.useFakeTimers();
    let n = 0;
    const doFetch = vi.fn(async () => (n++ === 0 ? new Response("busy", { status: 429 }) : new Response("ok", { status: 200 })));
    const p = fetchWithRetry("x", doFetch);
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});
