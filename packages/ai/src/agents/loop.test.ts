import { describe, it, expect } from "vitest";
import { filterHistory, filterCited } from "./loop.js";

describe("filterHistory", () => {
  it("drops blank turns", () => {
    const kept = filterHistory([
      { role: "user", content: "real question" },
      { role: "assistant", content: "" },
      { role: "user", content: "   " },
      { role: "assistant", content: "\n\t " },
      { role: "assistant", content: "real answer" },
    ]);
    expect(kept.map((h) => h.content)).toEqual(["real question", "real answer"]);
  });

  it("preserves order and does not trim surviving content", () => {
    const kept = filterHistory([
      { role: "user", content: "  padded  " },
      { role: "assistant", content: "b" },
    ]);
    expect(kept).toEqual([
      { role: "user", content: "  padded  " },
      { role: "assistant", content: "b" },
    ]);
  });

  it("returns nothing for an all-blank history", () => {
    expect(filterHistory([{ role: "user", content: "" }])).toEqual([]);
  });
});

describe("filterCited", () => {
  const cites = [
    { n: 1, doc_id: "a" },
    { n: 2, doc_id: "b" },
    { n: 3, doc_id: "c" },
  ];

  it("keeps only referenced sources, in their original order", () => {
    expect(filterCited("Facts [^3] and more [^1].", cites)).toEqual([
      { n: 1, doc_id: "a" },
      { n: 3, doc_id: "c" },
    ]);
  });

  it("accepts both [n] and [^n]", () => {
    expect(filterCited("plain [2] and caret [^1]", cites).map((c) => c.n)).toEqual([1, 2]);
  });

  it("drops everything when the prose cites nothing", () => {
    expect(filterCited("No markers at all.", cites)).toEqual([]);
  });

  it("ignores markers that match no source", () => {
    expect(filterCited("Invented [^9].", cites)).toEqual([]);
  });

  it("counts a repeated marker once", () => {
    expect(filterCited("[^1] and again [^1]", cites)).toEqual([{ n: 1, doc_id: "a" }]);
  });
});
