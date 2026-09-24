/**
 * Pins the schema's mark set to the one `CODE_EXCLUDES` was written against, so a
 * new mark fails here until someone decides whether markdown can spell it inside
 * backticks. The web parity test cannot catch this: a mark added to both schemas
 * keeps them in parity.
 */
import { describe, it, expect } from "vitest";
import { getStugaSchema, CODE_EXCLUDES } from "./schema.js";

/**
 * Every mark Stuga has, in RANK order (the order `getSchema` mounts them).
 *
 * Rank is load-bearing, not cosmetic: `docToMarkdown` nests marks by rank, so
 * `link` sitting ahead of `code` is what makes a code span that is a link's
 * text serialize as `` [`x`](url) `` rather than the meaningless
 * `` `[x](url)` ``. Link is a priority-1000 Tiptap extension and code is
 * remounted after StarterKit, which is what produces this order.
 */
const MARKS = ["link", "bold", "italic", "strike", "underline", "code"];

describe("the Stuga mark set", () => {
  const schema = getStugaSchema();

  it("is exactly the six marks CODE_EXCLUDES was written against", () => {
    // If this fails you have added (or removed) a mark. Before updating the
    // literal, decide whether Markdown can express the new mark INSIDE a code
    // span. If it cannot — which is true of every emphasis-like mark, since the
    // content of a code span is verbatim — it belongs in CODE_EXCLUDES. If it
    // can, or it is spelt around the span like `link` is, it must stay out.
    expect(Object.keys(schema.marks)).toEqual(MARKS);
  });

  it("keeps `link` OUT of the code span's exclusions, and every other mark IN", () => {
    // The rule the exclusion list encodes, restated as a predicate over the
    // schema rather than as a copy of the string — so the two cannot drift.
    const excluded = new Set(CODE_EXCLUDES.split(" "));
    expect([...excluded].sort()).toEqual(MARKS.filter((m) => m !== "link").sort());
    expect(excluded.has("link")).toBe(false);
  });

  it("names `code` in its own exclusions, so a mark still excludes itself", () => {
    // An explicit `excludes` REPLACES ProseMirror's default of "self", so
    // dropping `code` from the list would let two code marks coexist on one
    // text node.
    expect(CODE_EXCLUDES.split(" ")).toContain("code");
    expect(schema.marks.code!.excludes(schema.marks.code!)).toBe(true);
  });

  it("lets a text node carry link AND code together", () => {
    // The whole point of narrowing Tiptap's `excludes: "_"`: the href of
    // `` [`x.com`](https://x.com/) `` has a node to live on. Asserted through
    // `addToSet`, which is the eviction rule the parser and the editor both go
    // through.
    const both = schema.marks
      .code!.create()
      .addToSet([schema.marks.link!.create({ href: "https://x.com/" })]);
    expect(both.map((m) => m.type.name)).toEqual(["link", "code"]);
  });

  it("still evicts every emphasis mark from a code span", () => {
    for (const name of MARKS.filter((m) => m !== "link" && m !== "code")) {
      const set = schema.marks.code!.create().addToSet([schema.marks[name]!.create()]);
      expect(
        set.map((m) => m.type.name),
        `code must evict ${name}`,
      ).toEqual(["code"]);
    }
  });
});
