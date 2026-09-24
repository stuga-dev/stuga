/**
 * The round-trip invariant on a whole ~1000-line document rather than a snippet:
 *
 *   1. live.eq(markdownToDoc(currentMd))    — the live doc is its own projection
 *   2. docToMarkdown(reparse) === currentMd  — the projection is a fixed point
 *   3. every hunk `computeStrEdits` generates anchors uniquely in it
 *
 * Any block where live and projection disagree reads to the 3-way merge as a
 * concurrent edit and unanchors the hunks around it. The committed fixture has
 * hundreds of blocks, every node and mark, emphasis against code spans and lines
 * repeated across sections. Point `STUGA_LARGE_DOC` at another file to measure a real one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode } from "prosemirror-model";
import {
  applyMarkdownToYXmlFragment,
  applyStrEditsStrict,
  computeStrEdits,
  docToMarkdown,
  getStugaSchema,
  markdownToDoc,
  previewBlockSegments,
  topBlocks,
  yXmlFragmentToMarkdown,
} from "./index.js";
import fixtureMarkdown from "./fixtures/large-document.md?raw";

/** Point at any markdown file to re-measure all of this on a real document. */
const OVERRIDE = process.env.STUGA_LARGE_DOC;
/** Scenarios below are written against the fixture; an overridden document need not contain them. */
const usingFixture = !OVERRIDE;
const schema = getStugaSchema();

/**
 * The live document the way the running app really gets it: markdown applied
 * into a Y.XmlFragment, read back through the y-tiptap binding — plus the
 * markdown projection of that same fragment, which is what every hunk anchors
 * in. Building the "live" doc with `markdownToDoc` instead would make step 1
 * true by construction and hide the entire bug.
 */
function live(md: string): { doc: PMNode; currentMd: string } {
  const frag = new Y.Doc().getXmlFragment("default");
  applyMarkdownToYXmlFragment(frag, md, { schema, origin: { agent: "importer" } });
  return {
    doc: yXmlFragmentToProseMirrorRootNode(frag, schema) as PMNode,
    currentMd: yXmlFragmentToMarkdown(frag, schema),
  };
}

/** apps/web's MAX_SEGMENTS_PER_HUNK — a hunk painting more regions than this is
 *  dropped rather than shown in the wrong place. Mirrored, not imported: the web
 *  app is downstream of this package. */
const MAX_SEGMENTS_PER_HUNK = 4;

/** `doc` and `text` are structural; no markdown document can omit or add them. */
const UNWRITABLE_NODES = new Set(["doc", "text"]);
/** `underline` has no CommonMark/GFM spelling at all — a documented loss pinned
 *  by round-trip.test.ts, so a markdown fixture cannot carry it by construction. */
const UNWRITABLE_MARKS = new Set(["underline"]);

describe(`large document round-trip (${OVERRIDE ?? "fixtures/large-document.md"})`, () => {
  const source = OVERRIDE ? readFileSync(OVERRIDE, "utf8") : fixtureMarkdown;

  it("is a whole document, not a snippet", () => {
    // The point of this file is scale: a projection bug that hides in three
    // blocks out of hundreds does not reproduce in a ten-line fixture. If the
    // fixture is ever trimmed, these assertions are what notices.
    const { doc } = live(source);
    expect(topBlocks(doc).length, "top-level blocks").toBeGreaterThan(300);
    expect(source.split("\n").length, "lines").toBeGreaterThan(900);
    if (!usingFixture) return;
    // ...and that it exercises the WHOLE schema, which is the other half of what
    // makes parsing a whole document worthwhile. Derived from the schema rather
    // than from a hand-kept list: add a node or mark to Stuga and this goes red
    // until the fixture covers it, which is the only way a document-scale test
    // stays document-scale.
    const nodes = new Set<string>();
    const marks = new Set<string>();
    doc.descendants((n) => {
      nodes.add(n.type.name);
      n.marks.forEach((m) => marks.add(m.type.name));
      return true;
    });
    const missingNodes = Object.keys(schema.nodes).filter((n) => !nodes.has(n) && !UNWRITABLE_NODES.has(n));
    const missingMarks = Object.keys(schema.marks).filter((m) => !marks.has(m) && !UNWRITABLE_MARKS.has(m));
    expect(missingNodes, "schema nodes the fixture no longer exercises").toEqual([]);
    expect(missingMarks, "schema marks the fixture no longer exercises").toEqual([]);
  });

  it("the live CRDT document equals its own re-parsed markdown, block for block", () => {
    const { doc, currentMd } = live(source);
    const reparsed = markdownToDoc(currentMd, schema);
    // Per-block first, so a failure names the blocks that diverge.
    const liveBlocks = topBlocks(doc);
    const backBlocks = topBlocks(reparsed);
    expect(backBlocks.length, "block count changed across parse(serialize(live))").toBe(liveBlocks.length);
    const diverged = liveBlocks
      .map((b, i) => (b.eq(backBlocks[i]!) ? null : i))
      .filter((i): i is number => i !== null);
    expect(diverged, `blocks that differ: ${JSON.stringify(diverged)}`).toEqual([]);
    expect(doc.eq(reparsed)).toBe(true);
  });

  it("the markdown projection is a fixed point", () => {
    const { currentMd } = live(source);
    expect(docToMarkdown(markdownToDoc(currentMd, schema))).toBe(currentMd);
    // ...and stays one through a second trip over the CRDT, which is what an
    // Accept actually does.
    expect(live(currentMd).currentMd).toBe(currentMd);
  });

  /**
   * Whole-document rewrites of one term, the shape of "change X to Y everywhere":
   * `points→days` touches ~190 sites across prose, tables, lists and code; the
   * other two edit lines the document repeats verbatim, so each hunk must still
   * be unique in the baseline to be accepted alone.
   */
  const SCENARIOS: [name: string, rewrite: (md: string) => string][] = [
    ["points→days", (md) => md.replace(/points/g, "days").replace(/Points/g, "Days")],
    ["a heading repeated in three sections", (md) => md.replace(/## Acceptance criteria/g, "## Acceptance criteria (AC)")],
    [
      "a template line repeated in three sections",
      (md) => md.replace(/THEN the rest of the run stays pending/g, "THEN every other hunk stays pending"),
    ],
  ];

  for (const [name, rewrite] of SCENARIOS) {
    it(`every hunk of "${name}" anchors uniquely and paints a bounded region`, () => {
      const { doc, currentMd } = live(source);
      const nextMd = rewrite(currentMd);
      if (nextMd === currentMd && !usingFixture) return; // absent from an overridden document
      expect(nextMd, "the document must actually contain the text").not.toBe(currentMd);

      const hunks = computeStrEdits(currentMd, nextMd, schema);
      expect(hunks.length).toBeGreaterThan(1);

      const unanchored: number[] = [];
      const sprawling: number[] = [];
      hunks.forEach((h, i) => {
        // 1. Locatable on its own, against the untouched document, in any order —
        //    `buildRunSegments` singles out each hunk exactly this way, and so does
        //    the server when the reviewer decides a single hunk_id.
        const { applied, markdown } = applyStrEditsStrict(currentMd, [h]);
        if (applied.length !== 1) {
          unanchored.push(i);
          return;
        }
        // 2. And the region it changes stays local. A hunk whose segments sprawl
        //    is what a phantom "concurrent human edit" looks like from here.
        const segs = previewBlockSegments(doc, markdown, currentMd, schema);
        if (segs.length === 0 || segs.length > MAX_SEGMENTS_PER_HUNK) sprawling.push(i);
      });
      expect(unanchored, `hunks whose old_string no longer matches uniquely: ${unanchored}`).toEqual([]);
      expect(sprawling, `hunks whose paint sprawls past the cap: ${sprawling}`).toEqual([]);
    });
  }
});
