import { describe, expect, it } from "vitest";
import { interleaveByRank } from "./merge.js";

describe("interleaveByRank", () => {
  it("takes every list's first before any list's second, in list order", () => {
    expect(interleaveByRank([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]], 10)).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
  });

  it("stops at the limit, and handles empty lists", () => {
    expect(interleaveByRank([["a1", "a2"], ["b1", "b2"]], 3)).toEqual(["a1", "b1", "a2"]);
    expect(interleaveByRank([[], ["b1"]], 5)).toEqual(["b1"]);
    expect(interleaveByRank<string>([], 5)).toEqual([]);
    expect(interleaveByRank([["a1"]], 0)).toEqual([]);
  });

  it("is the identity for one list", () => {
    expect(interleaveByRank([["a1", "a2", "a3"]], 2)).toEqual(["a1", "a2"]);
  });
});
