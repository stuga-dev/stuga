import { describe, expect, it } from "vitest";
import { readBodyUpTo } from "./body.js";

/** A POST whose body arrives in `chunks`, with a `content-length` when `length` is given. */
function post(chunks: number[], length?: number): Request {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at === chunks.length) return controller.close();
      controller.enqueue(new Uint8Array(chunks[at]!).fill(at + 1));
      at += 1;
    },
  });
  const headers = length === undefined ? {} : { "content-length": String(length) };
  return new Request("https://node.test/upload", { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

describe("readBodyUpTo", () => {
  it("reads a body of a stated length whole, and one of none as it comes", async () => {
    const stated = await readBodyUpTo(post([3, 2], 5), 10);
    expect([...stated!]).toEqual([1, 1, 1, 2, 2]);
    const streamed = await readBodyUpTo(post([40_000, 40_000, 1]), 100_000);
    expect(streamed!.byteLength).toBe(80_001);
    expect([streamed![0], streamed![40_000], streamed![80_000]]).toEqual([1, 2, 3]);
  });

  it("answers null past the cap: at once for a stated length, and once reading passes it otherwise", async () => {
    expect(await readBodyUpTo(post([], 11), 10)).toBeNull();
    expect(await readBodyUpTo(post([6, 6]), 10)).toBeNull();
    expect((await readBodyUpTo(post([6, 4]), 10))!.byteLength).toBe(10);
  });
});
