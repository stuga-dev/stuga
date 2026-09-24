import { describe, it, expect } from "vitest";
import { markdownToDoc } from "./markdown/parse.js";
import { docToMarkdown } from "./markdown/serialize.js";
import { getStugaSchema } from "./schema.js";

/**
 * parse(serialize(doc)) keeps adjacent lists apart: markdown starts a new list
 * only where the bullet marker or ordered delimiter changes, so a lost boundary
 * would drop a top-level block and shift every index after it.
 */
const schema = getStugaSchema();

const roundTrips = (md: string): { ok: boolean; before: number; after: number } => {
  const doc = markdownToDoc(md, schema);
  const back = markdownToDoc(docToMarkdown(doc), schema);
  return { ok: back.eq(doc), before: doc.childCount, after: back.childCount };
};

describe("list boundaries survive a markdown round-trip", () => {
  const cases: Array<[string, string, number]> = [
    ["two bullet lists", "- a\n- b\n\n* c\n* d\n", 2],
    ["three bullet lists", "- a\n\n* b\n\n- c\n", 3],
    ["two ordered lists", "1. a\n2. b\n\n3) c\n4) d\n", 2],
    ["checkbox list then bullet list", "- [ ] a\n- [ ] b\n\n* **Grain:** c\n", 2],
    ["bullet then ordered", "- a\n\n1. b\n", 2],
    ["nested list then sibling list", "- a\n  - a1\n  - a2\n\n* b\n", 2],
    ["single list is untouched", "- a\n- b\n", 1],
    [
      "document with table, checkboxes, bullets and two ordered lists",
      "## H\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] x\n- [ ] y\n\n* **G:** z\n\n1. one\n2. two\n\n3) three\n\npara\n",
      7,
    ],
  ];

  for (const [name, md, topBlocks] of cases) {
    it(name, () => {
      const r = roundTrips(md);
      expect(r.before).toBe(topBlocks);
      // Fused sibling lists would come back with fewer blocks.
      expect(r.after).toBe(topBlocks);
      expect(r.ok).toBe(true);
    });
  }

  it("keeps adjacent lists apart by alternating the marker", () => {
    const md = docToMarkdown(markdownToDoc("- a\n\n* b\n\n- c\n", schema));
    // Whatever the first marker is, neighbours must differ from it.
    const markers = md.split("\n").filter((l) => /^[*-] /.test(l)).map((l) => l[0]);
    expect(markers).toHaveLength(3);
    expect(markers[0]).not.toBe(markers[1]);
    expect(markers[1]).not.toBe(markers[2]);
  });

  it("keeps adjacent ordered lists apart by alternating the delimiter", () => {
    const md = docToMarkdown(markdownToDoc("1. a\n\n2) b\n", schema));
    expect(/^\s*\d+\.\s/m.test(md)).toBe(true);
    expect(/^\s*\d+\)\s/m.test(md)).toBe(true);
  });
});
