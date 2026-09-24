/**
 * Deterministic footnote synthesis (accept-time): the co-author's `[^n]` markers
 * → real markdown footnotes in a trailing definitions block (NO `## Sources`
 * heading — the editor hides the defs from the body and shows them in the Sources
 * tab). Covers renumbering across turns, merge, orphan-prune, and the fast path.
 */
import { describe, it, expect } from "vitest";
import { applyCitedStrEdits, applyRenumberedStrEdits, maxFootnoteNumber, reconcileFootnotes } from "./footnotes.js";
import { markdownToDoc } from "./markdown/parse.js";
import { docToMarkdown } from "./markdown/serialize.js";
import { getStugaSchema } from "./schema.js";
import type { CitationInput } from "./footnotes.js";
import type { StrEditOp } from "./diff/str-edits.js";

const CITE = (n: number, over: Partial<CitationInput> = {}): CitationInput => ({
  n,
  doc_id: `doc${n}`,
  title: `Doc ${n}`,
  heading_path: `Section ${n}`,
  content: `Excerpt ${n} text.`,
  ...over,
});

describe("applyCitedStrEdits", () => {
  it("appends a cited insert as a [^n] marker + a synthesized definition (no heading)", () => {
    const doc = "# Report\n\nIntro paragraph.";
    const edits: StrEditOp[] = [{ old_string: "", new_string: "\n\nEarth's mass is 5.97e24 kg [^1]." }];
    const out = applyCitedStrEdits(doc, edits, [CITE(1)]);
    expect(out).toContain("Earth's mass is 5.97e24 kg [^1].");
    // Definitions are emitted WITHOUT a "## Sources" heading (hidden in body,
    // shown in the Sources tab).
    expect(out).not.toMatch(/^##\s+Sources/m);
    expect(out).toContain('[^1]: [Doc 1 — Section 1](/doc/doc1) "Excerpt 1 text."');
    // It's real markdown that parses back to footnote nodes.
    const refs: number[] = [];
    const defs: number[] = [];
    markdownToDoc(out, getStugaSchema()).descendants((n) => {
      if (n.type.name === "footnoteReference") refs.push(n.attrs.n);
      if (n.type.name === "footnoteDefinition") defs.push(n.attrs.n);
    });
    expect(refs).toEqual([1]);
    expect(defs).toEqual([1]);
  });

  it("densely renumbers gappy search-position markers from 1 (the [^2],[^5] bug)", () => {
    // The model cites raw retrieval positions: it used the 2nd + 5th passages.
    const edits: StrEditOp[] = [
      { old_string: "", new_string: "\n\nF&B is Forecast and Build [^2]. It has 8 principles [^5]." },
    ];
    const citations = [
      CITE(2, { doc_id: "g", title: "Handbook", heading_path: "F&B", content: "Forecast and Build." }),
      CITE(5, { doc_id: "g", title: "Handbook", heading_path: "Principles", content: "Eight principles." }),
    ];
    const out = applyCitedStrEdits("# Doc", edits, citations);
    // Markers collapse to 1,2 in order of appearance — no [^2]/[^5] gaps.
    expect(out).toContain("Forecast and Build [^1].");
    expect(out).toContain("8 principles [^2].");
    expect(out).not.toContain("[^5]");
    expect(out).toContain('[^1]: [Handbook — F&B](/doc/g)');
    expect(out).toContain('[^2]: [Handbook — Principles](/doc/g)');
  });

  it("preserves first-appearance ORDER when markers appear out of numeric order", () => {
    // Cited [^5] before [^2] in the text → [^5]→1, [^2]→2.
    const edits: StrEditOp[] = [{ old_string: "", new_string: "\n\nA [^5] then B [^2]." }];
    const citations = [
      CITE(2, { doc_id: "d2", title: "Two", content: "two" }),
      CITE(5, { doc_id: "d5", title: "Five", content: "five" }),
    ];
    const out = applyCitedStrEdits("# Doc", edits, citations);
    expect(out).toContain("A [^1] then B [^2].");
    expect(out).toContain('[^1]: [Five');
    expect(out).toContain('[^2]: [Two');
  });

  it("renumbers a SECOND turn's citations past the doc's existing footnotes", () => {
    // Doc already has [^1] from a prior turn (heading-less definitions block).
    const doc = [
      "Fact one [^1].",
      "",
      '[^1]: [Doc 1 — Section 1](/doc/doc1) "Excerpt 1 text."',
    ].join("\n");
    // A new turn cites its OWN source as [^1]; it must become [^2] in the doc.
    const edits: StrEditOp[] = [{ old_string: "", new_string: "\n\nFact two [^1]." }];
    const out = applyCitedStrEdits(doc, edits, [CITE(1, { doc_id: "docX", title: "Doc X", heading_path: "S", content: "New." })]);
    expect(out).toContain("Fact one [^1].");
    expect(out).toContain("Fact two [^2].");
    expect(out).toContain('[^1]: [Doc 1 — Section 1](/doc/doc1)');
    expect(out).toContain('[^2]: [Doc X — S](/doc/docX) "New."');
    // No heading is ever emitted.
    expect(out).not.toMatch(/^##\s+Sources/m);
  });

  it("prunes a definition whose reference an edit deleted (orphan-prune)", () => {
    const doc = [
      "Keep this [^1]. Remove this [^2].",
      "",
      '[^1]: [Doc 1 — Section 1](/doc/doc1) "Excerpt 1 text."',
      '[^2]: [Doc 2 — Section 2](/doc/doc2) "Excerpt 2 text."',
    ].join("\n");
    // Delete the sentence carrying [^2].
    const edits: StrEditOp[] = [{ old_string: " Remove this [^2].", new_string: "" }];
    const out = applyCitedStrEdits(doc, edits, []);
    expect(out).toContain("Keep this [^1].");
    expect(out).not.toContain("[^2]");
    expect(out).toContain('[^1]: [Doc 1 — Section 1](/doc/doc1)');
  });

  it("drops the definitions block entirely when the last reference is removed", () => {
    const doc = ["Only fact [^1].", "", '[^1]: [Doc 1 — Section 1](/doc/doc1) "e"'].join("\n");
    const edits: StrEditOp[] = [{ old_string: "Only fact [^1].", new_string: "Only fact." }];
    const out = applyCitedStrEdits(doc, edits, []);
    expect(out).not.toContain("[^1]");
    expect(out.trim()).toBe("Only fact.");
  });

  it("no citations + no existing footnotes: identical to a plain surgical apply", () => {
    const doc = "Alpha\n\nBeta";
    const edits: StrEditOp[] = [{ old_string: "Beta", new_string: "Beta changed" }];
    const out = applyCitedStrEdits(doc, edits, []);
    expect(out).toBe("Alpha\n\nBeta changed");
    expect(out).not.toContain("Sources");
  });

  it("escapes brackets in titles/excerpts so the link/def stays valid", () => {
    const doc = "# D";
    const edits: StrEditOp[] = [{ old_string: "", new_string: "\n\nClaim [^1]." }];
    const out = applyCitedStrEdits(doc, edits, [
      CITE(1, { title: "A [bracketed] title", content: 'Has "quotes" and [brackets].' }),
    ]);
    // Brackets in the label are escaped; it still round-trips to a footnote def.
    expect(out).toContain("\\[bracketed\\]");
    let defs = 0;
    markdownToDoc(out, getStugaSchema()).descendants((n) => {
      if (n.type.name === "footnoteDefinition") defs++;
    });
    expect(defs).toBe(1);
  });

  it("survives a full markdown → CRDT-schema → markdown round-trip", () => {
    const doc = "# Doc\n\nBody.";
    const edits: StrEditOp[] = [{ old_string: "", new_string: "\n\nMore [^1]." }];
    const out = applyCitedStrEdits(doc, edits, [CITE(1)]);
    const reparsed = docToMarkdown(markdownToDoc(out, getStugaSchema()));
    expect(reparsed).toContain("More [^1].");
    expect(reparsed).toContain("[^1]: [Doc 1 — Section 1](/doc/doc1)");
  });
});

describe("maxFootnoteNumber", () => {
  it("finds the highest [^n] anywhere (refs or defs)", () => {
    expect(maxFootnoteNumber("no footnotes here")).toBe(0);
    expect(maxFootnoteNumber("a [^1] b [^7] c\n[^7]: def")).toBe(7);
  });
});

/**
 * The run ledger stages only the BODY half and reconciles definitions at commit
 * time, so the two halves must (a) still compose back to the one-shot function
 * for every headless caller, and (b) leave a consistent block no matter WHICH
 * hunks a reviewer accepted.
 */
describe("the two halves of applyCitedStrEdits", () => {
  // Every shape the one-shot suite above covers, as (doc, edits, citations).
  const CASES: Array<[string, string, StrEditOp[], CitationInput[]]> = [
    ["cited insert", "# Report\n\nIntro paragraph.", [{ old_string: "", new_string: "\n\nMass is 5.97e24 kg [^1]." }], [CITE(1)]],
    ["gappy markers", "# D\n\nBody.", [{ old_string: "", new_string: "\n\nA [^2]. B [^5]." }], [CITE(2), CITE(5)]],
    [
      "second turn past existing footnotes",
      ["Fact one [^1].", "", '[^1]: [Doc 1 — Section 1](/doc/doc1) "Excerpt 1 text."'].join("\n"),
      [{ old_string: "Fact one [^1].", new_string: "Fact one [^1]. Fact two [^3]." }],
      [CITE(3, { doc_id: "docX", title: "Doc X", heading_path: "S", content: null })],
    ],
    [
      "orphan-prune with no incoming citations",
      ["Keep [^1]. Drop [^2].", "", '[^1]: [Doc 1](/doc/doc1)', '[^2]: [Doc 2](/doc/doc2)'].join("\n"),
      [{ old_string: " Drop [^2].", new_string: "" }],
      [],
    ],
    ["fast path: nothing cited, no footnotes", "Alpha\n\nBeta", [{ old_string: "Beta", new_string: "Beta changed" }], []],
  ];

  it.each(CASES)("composes back to applyCitedStrEdits: %s", (_label, doc, edits, citations) => {
    const oneShot = applyCitedStrEdits(doc, edits, citations);
    const { markdown, renumber } = applyRenumberedStrEdits(doc, edits, citations);
    // The fast path deliberately skips reconciliation (see applyCitedStrEdits):
    // with nothing to renumber there is nothing to reconcile, and running it
    // anyway would rewrite trailing whitespace on an ordinary edit.
    const fresh = citations.length === 0 && !/\[\^\d+\]/.test(doc);
    const split = fresh ? markdown : reconcileFootnotes(markdown, citations, renumber);
    expect(split).toBe(oneShot);
  });

  it("applyRenumberedStrEdits stages the body WITHOUT a definitions block", () => {
    const doc = "# Report\n\nIntro.";
    const edits: StrEditOp[] = [{ old_string: "", new_string: "\n\nClaim [^1]." }];
    const { markdown, renumber } = applyRenumberedStrEdits(doc, edits, [CITE(1)]);
    expect(markdown).toContain("Claim [^1].");
    // THE POINT: no trailing "[^1]: …" hunk for the reviewer to decide separately.
    expect(markdown).not.toMatch(/^\[\^1\]:/m);
    expect(renumber.get(1)).toBe(1);
  });

  it("reconcileFootnotes materializes a definition only for a marker that LANDED", () => {
    const cites = [CITE(1), CITE(2)];
    const renumber = new Map([
      [1, 1],
      [2, 2],
    ]);
    // The reviewer accepted the hunk carrying [^1] and rejected the [^2] one, so
    // only [^1] is in the body — [^2] must not appear as an orphan definition.
    const body = "Intro.\n\nAccepted claim [^1].";
    const out = reconcileFootnotes(body, cites, renumber);
    expect(out).toContain('[^1]: [Doc 1 — Section 1](/doc/doc1) "Excerpt 1 text."');
    expect(out).not.toContain("[^2]");
  });

  it("reconcileFootnotes is idempotent (it runs on every commit)", () => {
    const cites = [CITE(1)];
    const renumber = new Map([[1, 1]]);
    const once = reconcileFootnotes("Body [^1].", cites, renumber);
    expect(reconcileFootnotes(once, cites, renumber)).toBe(once);
    // And again with no citations at all — a later accept on the same document
    // must not strip the block it already wrote.
    expect(reconcileFootnotes(once, [], new Map())).toBe(once);
  });

  it("reconcileFootnotes drops a definition a REVERT unwound the reference of", () => {
    const withDef = ["Claim [^1].", "", '[^1]: [Doc 1](/doc/doc1)'].join("\n");
    const reverted = reconcileFootnotes("Claim.", [], new Map());
    expect(reverted.trim()).toBe("Claim.");
    expect(reconcileFootnotes(withDef, [], new Map())).toContain("[^1]:");
  });

  it("keeps a definition-shaped line inside a longer fence that contains a shorter run", () => {
    const md = ["Prose.[^1]", "", "````", "```", "[^2]: sample text", "```", "````", "", "[^1]: real"].join("\n");
    const out = reconcileFootnotes(md, []);
    expect(out).toContain("[^2]: sample text");
    expect(out).toContain("[^1]: real");
  });

  it("leaves footnote definitions inside a fenced code block alone", () => {
    // Lifting the sample's own line out would edit the snippet and then delete it as unreferenced.
    const md = [
      "Prose with a real note.[^1]",
      "",
      "```markdown",
      "[^1]: this line belongs to the sample",
      "```",
      "",
      "[^1]: the document's own definition",
    ].join("\n");
    const out = reconcileFootnotes(md, []);
    expect(out).toContain("[^1]: this line belongs to the sample");
    expect(out).toContain("[^1]: the document's own definition");
  });
});
