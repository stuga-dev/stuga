import { describe, expect, it } from "vitest";
import { tokensRead } from "./usage";

describe("tokensRead", () => {
  it("counts the prompt a provider served from its cache, which the input count leaves out", () => {
    // 22 co-author calls on a cached prompt: the uncached remainder alone looked like 7 tokens a call.
    expect(tokensRead({ input_tokens: 154, output_tokens: 14_166, cache_read_tokens: 180_000, cache_write_tokens: 9_000 })).toBe(189_154);
  });
});
