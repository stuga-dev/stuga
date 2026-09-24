// @vitest-environment jsdom
/**
 * The run overlay's placement logic over the production schema. `planRunPaint`'s
 * `resolve` callback stands in for the live Yjs binding.
 */
import { describe, it, expect } from "vitest";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import {
  computeStrEdits,
  docToMarkdown,
  getStugaSchema,
  markdownToDoc,
  topBlocks,
} from "@stuga/crdt-ops";
import type { RelRange } from "../rel-range";
import {
  RUN_HUNK_EVENT,
  buildRunSegments,
  classifyRunHunks,
  ghostVariant,
  ghostWidgetKey,
  hunkSummary,
  mergeOverlapping,
  planRunPaint,
  rangesOverlap,
  tableRowContext,
  type RunPreviewData,
  type HunkKey,
  type PreviewHunkPart,
  type PreviewSegment,
  type RunHunkDecisionDetail,
  type RunPreviewHunk,
} from "./plan";
import { runGhost } from "./ghost-dom";
import { itemKey } from "../../review/run-ledger";

const schema = getStugaSchema();
const RUN = "run_a";

function hunk(id: string, oldStr: string, newStr: string, over: Partial<RunPreviewHunk> = {}): RunPreviewHunk {
  return { runId: RUN, id, old_string: oldStr, new_string: newStr, ...over };
}

function build(md: string, hunks: RunPreviewHunk[]) {
  return buildRunSegments(markdownToDoc(md, schema), md, hunks, schema);
}

/** Totals map giving every listed key the same denominator (HunkTotals is Map-only). */
const sameTotal = (n: number, ...keys: HunkKey[]) => new Map(keys.map((k) => [k, n] as const));

// ---------------------------------------------------------------------------
// keys + summaries
// ---------------------------------------------------------------------------

describe("hunk identity", () => {
  it("summarizes a change with a kind marker and collapsed whitespace", () => {
    expect(hunkSummary("old text", "new   text\nhere")).toBe("~ new text here");
    expect(hunkSummary("", "added")).toBe("+ added");
    expect(hunkSummary("removed", "")).toBe("− removed");
  });

  it("truncates a long summary so a ghost sub-label stays one line", () => {
    const s = hunkSummary("a", "x".repeat(200));
    expect(s.length).toBeLessThanOrEqual(62);
    expect(s.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRunSegments — what can be painted at all
// ---------------------------------------------------------------------------

describe("buildRunSegments", () => {
  const DOC = "First paragraph about cats.\n\nSecond paragraph about dogs.\n";

  it("anchors a hunk whose old_string matches exactly once", () => {
    const { segments, unpaintable } = build(DOC, [hunk("h1", "about cats", "about kittens")]);
    expect(unpaintable).toEqual([]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.hunks.map((p) => p.key)).toEqual(["run_a:h1"]);
  });

  it("reports a non-unique hunk as unpaintable instead of ghosting the wrong paragraph", () => {
    const md = "Repeat me.\n\nSomething else.\n\nRepeat me.\n";
    const { segments, unpaintable } = build(md, [hunk("h1", "Repeat me.", "Changed.")]);
    expect(segments).toEqual([]);
    expect(unpaintable).toEqual(["run_a:h1"]);
  });

  it("reports a hunk whose old_string is gone as unpaintable", () => {
    const { segments, unpaintable } = build(DOC, [hunk("h1", "about hamsters", "about gerbils")]);
    expect(segments).toEqual([]);
    expect(unpaintable).toEqual(["run_a:h1"]);
  });

  it("chooses the WORD-level form for a single-block reword", () => {
    const { segments } = build(DOC, [hunk("h1", "about cats", "about kittens")]);
    const part = segments[0]!.hunks[0]!;
    expect(part.words).toBeDefined();
    expect(part.words!.filter((w) => w.type === "del").map((w) => w.text)).toEqual(["cats."]);
    expect(part.words!.filter((w) => w.type === "ins").map((w) => w.text)).toEqual(["kittens."]);
    expect(part.words!.some((w) => w.type === "eq" && w.text.includes("First"))).toBe(true);
  });

  it("keeps the whole-block form when the block CHANGES TYPE", () => {
    const md = "Just a paragraph.\n";
    const { segments } = build(md, [hunk("h1", "Just a paragraph.", "# Just a heading")]);
    expect(segments).toHaveLength(1);
    const part = segments[0]!.hunks[0]!;
    expect(part.words).toBeUndefined();
    expect(part.replacement).toHaveLength(1);
    expect(part.replacement[0]!.type.name).toBe("heading");
  });

  it("MERGES two hunks landing on the same block into one ghost", () => {
    const md = "The quick brown fox jumps over the lazy dog.\n";
    const { segments } = build(md, [
      hunk("h1", "quick", "swift"),
      hunk("h2", "lazy", "sleepy"),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.hunks.map((p) => p.key)).toEqual(["run_a:h1", "run_a:h2"]);
    expect(segments[0]!.hunks.map((p) => p.summary)).toEqual(["~ swift", "~ sleepy"]);
  });

  it("keeps hunks in DIFFERENT blocks as separate ghosts", () => {
    const { segments } = build(DOC, [
      hunk("h1", "about cats", "about kittens"),
      hunk("h2", "about dogs", "about puppies"),
    ]);
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.hunks.map((p) => p.key))).toEqual([["run_a:h1"], ["run_a:h2"]]);
    expect(segments[0]!.from).toBeLessThan(segments[1]!.from);
  });

  it("emits SEVERAL segments for one hunk that spans an unchanged middle block", () => {
    const md = "alpha one\n\nmiddle stays\n\nalpha two\n";
    const { segments } = build(md, [
      hunk("h1", "alpha one\n\nmiddle stays\n\nalpha two", "beta one\n\nmiddle stays\n\nbeta two"),
    ]);
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.hunks.length === 1 && s.hunks[0]!.key === "run_a:h1")).toBe(true);
    const keys = segments.map((s, i) => ghostWidgetKey(i, s.hunks.map((p) => p.key)));
    expect(new Set(keys).size).toBe(2);
  });

  it("attributes hunks to their agent ONLY when more than one run is open", () => {
    const md = "First paragraph about cats.\n\nSecond paragraph about dogs.\n";
    const oneRun = build(md, [
      hunk("h1", "about cats", "about kittens", { agent: "Claude" }),
      hunk("h2", "about dogs", "about puppies", { agent: "Claude" }),
    ]);
    expect(oneRun.segments.flatMap((s) => s.hunks).every((p) => p.agent === undefined)).toBe(true);

    const twoRuns = build(md, [
      hunk("h1", "about cats", "about kittens", { agent: "Claude" }),
      hunk("h1", "about dogs", "about puppies", { runId: "run_b", agent: "Codex" }),
    ]);
    expect(twoRuns.segments.flatMap((s) => s.hunks).map((p) => p.agent)).toEqual(["Claude", "Codex"]);
  });
});

// ---------------------------------------------------------------------------
// nested granularity: segments address the child of a list, table or quote that changed
// ---------------------------------------------------------------------------
type Doc = ReturnType<typeof markdownToDoc>;

/** Live [from, to) of one child of one top-level block — the truth to match. */
function childRange(doc: Doc, blockIndex: number, childIndex: number): { from: number; to: number } {
  let from = 0;
  for (let i = 0; i < blockIndex; i++) from += doc.child(i).nodeSize;
  const container = doc.child(blockIndex);
  from += 1; // step inside the container's own open token
  for (let i = 0; i < childIndex; i++) from += container.child(i).nodeSize;
  return { from, to: from + container.child(childIndex).nodeSize };
}

/** Live [from, to) of a whole top-level block. */
function blockRange(doc: Doc, blockIndex: number): { from: number; to: number } {
  let from = 0;
  for (let i = 0; i < blockIndex; i++) from += doc.child(i).nodeSize;
  return { from, to: from + doc.child(blockIndex).nodeSize };
}

describe("nested segments", () => {
  // Serializer-canonical markdown, the form the CRDT stores and hunks anchor in.
  const CHECKLIST = [
    "## Ready to Start",
    "",
    "* Task has a clear visible result",
    "",
    "* Task is Walked and estimated in points",
    "",
    "* Finish checks are written",
    "",
    "* Materials are ordered",
    "",
    "* Safety plan agreed",
    "",
    "* Photos attached",
  ].join("\n");

  it("strikes ONLY the removed bullet, not the whole six-item list", () => {
    const doc = markdownToDoc(CHECKLIST, schema);
    const { segments, unpaintable } = buildRunSegments(
      doc,
      CHECKLIST,
      [hunk("h1", "* Task is Walked and estimated in points\n\n", "")],
      schema,
    );
    expect(unpaintable).toEqual([]);
    expect(segments).toHaveLength(1);
    expect({ from: segments[0]!.from, to: segments[0]!.to }).toEqual(childRange(doc, 1, 1));
    const list = blockRange(doc, 1);
    expect(segments[0]!.to - segments[0]!.from).toBeLessThan(list.to - list.from);
    expect(segments[0]!.hunks[0]!.replacement).toEqual([]);
    expect(segments[0]!.hunks[0]!.words).toBeUndefined();
  });

  it("carries Accept/Reject on a pure-deletion ghost", () => {
    const doc = markdownToDoc(CHECKLIST, schema);
    const { segments } = buildRunSegments(
      doc,
      CHECKLIST,
      [hunk("h1", "* Task is Walked and estimated in points\n\n", "")],
      schema,
    );
    const part = segments[0]!.hunks[0]!;
    const el = runGhost([part], new Map([[part.key, 1]]), sameTotal(1, part.key), new Set());
    expect(el.querySelector("p")).toBeNull();
    expect(el.className).toContain("ai-preview-ghost--removal");
    expect(el.className).not.toContain("ai-preview-insert--block");
    expect(el.querySelector<HTMLElement>("[data-hunk-key]")!.dataset.hunkKey).toBe("run_a:h1");
    expect(el.querySelectorAll(".ai-preview-hunk-btn")).toHaveLength(2);
    expect(el.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--accept")!.disabled).toBe(false);
  });

  it("rewords one bullet as WORDS, leaving its siblings untouched", () => {
    const doc = markdownToDoc(CHECKLIST, schema);
    const { segments } = buildRunSegments(
      doc,
      CHECKLIST,
      [hunk("h1", "Safety plan agreed", "Safety plan signed off")],
      schema,
    );
    expect(segments).toHaveLength(1);
    const part = segments[0]!.hunks[0]!;
    expect(part.words!.filter((w) => w.type === "ins").map((w) => w.text)).toEqual(["signed off"]);
    const item = childRange(doc, 1, 4);
    expect(segments[0]!.from).toBeGreaterThanOrEqual(item.from);
    expect(segments[0]!.to).toBeLessThanOrEqual(item.to);
  });

  it("keeps two edits in ONE list independently decidable", () => {
    const doc = markdownToDoc(CHECKLIST, schema);
    const { segments, unpaintable } = buildRunSegments(
      doc,
      CHECKLIST,
      [
        hunk("h1", "* Materials are ordered\n\n", ""),
        hunk("h2", "Photos attached", "Photos linked"),
      ],
      schema,
    );
    expect(unpaintable).toEqual([]);
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.hunks.map((p) => p.key))).toEqual([["run_a:h1"], ["run_a:h2"]]);
    expect(segments[0]!.from).toBeLessThan(segments[1]!.from);
  });

  it("marks ONE table row for a single changed cell, not the whole table", () => {
    const TABLE = ["| Stage | Owner |", "| --- | --- |", "| Draft | Ana |", "| Review | Bo |", ""].join("\n");
    const doc = markdownToDoc(TABLE, schema);
    const { segments, unpaintable } = buildRunSegments(
      doc,
      TABLE,
      [hunk("h1", "| Review | Bo |", "| Review | Cy |")],
      schema,
    );
    expect(unpaintable).toEqual([]);
    expect(segments).toHaveLength(1);
    // A cell has no standalone markdown, so a row is the finest unit.
    expect({ from: segments[0]!.from, to: segments[0]!.to }).toEqual(childRange(doc, 0, 2));
    const table = blockRange(doc, 0);
    expect(segments[0]!.from).toBeGreaterThan(table.from);
    expect(segments[0]!.to).toBeLessThan(table.to);
  });

  it("marks ONE quoted paragraph inside a blockquote", () => {
    const QUOTE = ["> First quoted line", ">", "> Second quoted line", ">", "> Third quoted line"].join("\n");
    const doc = markdownToDoc(QUOTE, schema);
    const { segments, unpaintable } = buildRunSegments(
      doc,
      QUOTE,
      [hunk("h1", "Second quoted line", "Second quoted line, revised")],
      schema,
    );
    expect(unpaintable).toEqual([]);
    expect(segments).toHaveLength(1);
    const para = childRange(doc, 0, 1);
    expect(segments[0]!.from).toBeGreaterThanOrEqual(para.from);
    expect(segments[0]!.to).toBeLessThanOrEqual(para.to);
    expect(segments[0]!.to - segments[0]!.from).toBeLessThan(blockRange(doc, 0).to - blockRange(doc, 0).from);
  });

  it("still emits ONE segment for a whole list replaced by a different structure", () => {
    const md = ["* one", "", "* two"].join("\n");
    const doc = markdownToDoc(md, schema);
    const { segments } = buildRunSegments(doc, md, [hunk("h1", md, "Just a sentence now.")], schema);
    expect(segments).toHaveLength(1);
    expect({ from: segments[0]!.from, to: segments[0]!.to }).toEqual(blockRange(doc, 0));
    expect(segments[0]!.hunks[0]!.replacement.map((n) => n.type.name)).toEqual(["paragraph"]);
  });
});

// ---------------------------------------------------------------------------
// a whole run over a long document with tables
// ---------------------------------------------------------------------------

/**
 * One ghost per changed location, each on the block its own hunk changes and
 * rendering its own text, including when resized table cells carry `colwidth`,
 * which markdown can't express.
 */
describe("a whole run over a long document with tables", () => {
  /** Serializer-canonical, i.e. the form the CRDT actually stores. */
  const canonical = (md: string) => docToMarkdown(markdownToDoc(md, schema));

  const REVIEW_DOC = canonical(
    [
      "# Cottage Work Cycle",
      "",
      "## 3. Planning Cadence",
      "",
      "| Cadence | Layer | Estimation unit | Output |",
      "| --- | --- | --- | --- |",
      "| Yearly | 0 · Charter & Purpose | — | Five-year note / letter: why we keep it |",
      "| Quarterly | 1 · Season plan | seasons | Budgets and season plans |",
      "| Bi-weekly | 4 · Work | points (§4.4) | One cycle |",
      "",
      "### 4.4 Sizing Method (Points)",
      "",
      "Task points are a relative measure of effort agreed by the team at the walk-through.",
      "",
      "**Carry-over.** Anything not Done at cycle close goes back on the list and is re-estimated.",
      "",
      "## Ready to Start",
      "",
      "* Task has a clear visible result",
      "",
      "* Task is `Walked` and estimated in points",
      "",
      "* Finish checks are written",
      "",
      "## 5. Record Keeping",
      "",
      "| Record | Question it answers | Keeper |",
      "| --- | --- | --- |",
      "| Charter | Why do we keep it | Trustees |",
      "| Task | What a guest will notice | Host + Lead |",
      "",
      "## 6. Gatherings",
      "",
      "| Gathering | Trigger | Outcome |",
      "| --- | --- | --- |",
      "| §4.3 Planning | Cycle start | Booked work |",
      "| §4.4 Walk-through | Mid cycle | Sized list |",
      "",
      "### Task (the cycle's sizing unit)",
      "",
      "A task is the smallest unit that leaves the cottage better on its own.",
    ].join("\n"),
  );

  /** The agent's rewrite: points → days, touching eight scattered places. */
  const REVIEW_PROPOSAL = canonical(
    REVIEW_DOC.replace("points (§4.4)", "days (§4.4)")
      .replace("Method (Points)", "Method (Work Days)")
      .replace("Task points are a relative", "Task days are an absolute")
      .replace("goes back on the list and is re-estimated", "is re-scoped with the Host before it goes back")
      .replace("and estimated in points", "and estimated in days")
      .replace("Host + Lead |", "Host + Lead Stonemason |")
      .replace("Sized list", "Suggest a task split when sized over 5 days")
      .replace("the smallest unit", "the smallest **bookable** unit"),
  );

  /** The run's hunks, minted with the same `computeStrEdits` the document actor uses. */
  const REVIEW_HUNKS: RunPreviewHunk[] = computeStrEdits(REVIEW_DOC, REVIEW_PROPOSAL, schema).map((e, i) => ({
    runId: RUN,
    id: `h${i + 1}`,
    old_string: e.old_string,
    new_string: e.new_string,
  }));

  const KEYS = REVIEW_HUNKS.map((h) => itemKey(h.runId, h.id));

  /** Where each hunk's ghost belongs, computed from the document itself. */
  function expectedRanges(doc: Doc): { from: number; to: number }[] {
    return [
      childRange(doc, 2, 3), // "| Bi-weekly …" — 4th row of the cadence table
      blockRange(doc, 3), // "### 4.4 Sizing Method …"
      blockRange(doc, 4), // "Task points are a relative …"
      blockRange(doc, 5), // "**Carry-over.** …"
      childRange(doc, 7, 1), // 2nd bullet of the Ready to Start list
      childRange(doc, 9, 2), // "| Task …" — 3rd row of the record table
      childRange(doc, 11, 2), // "| §4.4 Walk-through …" — 3rd row of the gatherings table
      blockRange(doc, 13), // "A task is the smallest …"
    ];
  }

  /** The document with `colwidth` on every table cell, at unchanged positions. */
  function withResizedColumns(doc: Doc): Doc {
    const blocks: PMNode[] = [];
    doc.content.forEach((block) => {
      if (block.type.name !== "table") {
        blocks.push(block);
        return;
      }
      const rows: PMNode[] = [];
      block.content.forEach((row) => {
        const cells: PMNode[] = [];
        row.content.forEach((cell) => cells.push(cell.type.create({ ...cell.attrs, colwidth: [180] }, cell.content, cell.marks)));
        rows.push(row.copy(Fragment.fromArray(cells)));
      });
      blocks.push(block.copy(Fragment.fromArray(rows)));
    });
    return doc.copy(Fragment.fromArray(blocks));
  }

  /** What ONE ghost section actually renders — its proposed text. */
  function renderedText(part: PreviewHunkPart): string {
    if (part.words) return part.words.filter((w) => w.type !== "del").map((w) => w.text).join("");
    return part.replacement.map((n) => n.textContent).join(" ⏎ ");
  }

  it("mints one pending hunk per changed location (fixture sanity)", () => {
    expect(REVIEW_HUNKS).toHaveLength(8);
    expect(REVIEW_HUNKS[0]!.old_string).toContain("| Bi-weekly |");
    expect(REVIEW_HUNKS[5]!.old_string).toContain("| Task |");
    expect(REVIEW_HUNKS[6]!.old_string).toContain("| §4.4 Walk-through |");
  });

  it("gives every hunk its own ghost when the doc IS its markdown projection", () => {
    const doc = markdownToDoc(REVIEW_DOC, schema);
    const { segments, unpaintable } = buildRunSegments(doc, REVIEW_DOC, REVIEW_HUNKS, schema);

    expect(unpaintable).toEqual([]);
    expect(segments.map((s) => s.hunks.map((p) => p.key))).toEqual(KEYS.map((k) => [k]));
    const want = expectedRanges(doc);
    segments.forEach((seg, i) => {
      // The list item's segment is its paragraph, contained by the item.
      expect(seg.from).toBeGreaterThanOrEqual(want[i]!.from);
      expect(seg.to).toBeLessThanOrEqual(want[i]!.to);
    });
    expect(new Set(segments.flatMap((s) => s.hunks).map(renderedText)).size).toBe(8);
  });

  it("keeps every hunk on its own block when the live doc carries colwidth", () => {
    const doc = withResizedColumns(markdownToDoc(REVIEW_DOC, schema));
    const { segments, unpaintable } = buildRunSegments(doc, REVIEW_DOC, REVIEW_HUNKS, schema);

    expect(unpaintable).toEqual([]);
    expect(segments.map((s) => s.hunks.map((p) => p.key))).toEqual(KEYS.map((k) => [k]));
    expect(segments).toHaveLength(8);

    const want = expectedRanges(doc);
    segments.forEach((seg, i) => {
      expect(seg.from).toBeGreaterThanOrEqual(want[i]!.from);
      expect(seg.to).toBeLessThanOrEqual(want[i]!.to);
    });

    const rendered = segments.flatMap((s) => s.hunks).map(renderedText);
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(rendered.some((t) => t.includes("Five-year note / letter"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

describe("rangesOverlap / mergeOverlapping", () => {
  it("treats abutting half-open ranges as disjoint", () => {
    expect(rangesOverlap({ from: 0, to: 10 }, { from: 10, to: 20 })).toBe(false);
    expect(rangesOverlap({ from: 0, to: 11 }, { from: 10, to: 20 })).toBe(true);
  });

  it("treats a zero-width insertion touching a range as an overlap", () => {
    expect(rangesOverlap({ from: 10, to: 10 }, { from: 0, to: 10 })).toBe(true);
    expect(rangesOverlap({ from: 11, to: 11 }, { from: 0, to: 10 })).toBe(false);
  });

  it("merges intersecting drafts and dedupes repeated hunks", () => {
    const part = (key: string): PreviewHunkPart => ({
      runId: RUN,
      hunkId: key,
      key: itemKey(RUN, key),
      replacement: [],
      summary: `~ ${key}`,
    });
    const merged = mergeOverlapping([
      { from: 20, to: 30, hunks: [part("h3")] },
      { from: 0, to: 12, hunks: [part("h1")] },
      { from: 0, to: 12, hunks: [part("h2")] },
      { from: 10, to: 12, hunks: [part("h1")] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.hunks.map((p) => p.key)).toEqual(["run_a:h1", "run_a:h2"]);
    expect(merged[1]!.hunks.map((p) => p.key)).toEqual(["run_a:h3"]);
  });
});

// ---------------------------------------------------------------------------
// classification + paint planning
// ---------------------------------------------------------------------------

describe("classifyRunHunks", () => {
  it("orders anchored hunks by POSITION, not by build order", () => {
    const report = classifyRunHunks(
      [
        { from: 90, build: 0, keys: ["run_a:h3"] },
        { from: 10, build: 1, keys: ["run_a:h1"] },
        { from: 40, build: 2, keys: ["run_a:h2"] },
      ],
      [],
    );
    expect(report.anchored).toEqual(["run_a:h1", "run_a:h2", "run_a:h3"]);
  });

  it("lists a hunk ONCE even when it painted several segments", () => {
    const report = classifyRunHunks(
      [
        { from: 10, build: 0, keys: ["run_a:h1"] },
        { from: 50, build: 1, keys: ["run_a:h1"] },
      ],
      [],
    );
    expect(report.anchored).toEqual(["run_a:h1"]);
  });

  it("counts a hunk as anchored when only SOME of its segments were dropped", () => {
    const report = classifyRunHunks(
      [{ from: 10, build: 0, keys: ["run_a:h1"] }],
      [{ at: 50, build: 1, keys: ["run_a:h1"] }],
    );
    expect(report).toEqual({ anchored: ["run_a:h1"], unanchored: [] });
  });

  it("sorts unanchored hunks by known position, with positionless ones last", () => {
    const report = classifyRunHunks(
      [],
      [
        { at: null, build: 0, keys: ["run_a:h9"] },
        { at: 80, build: 1, keys: ["run_a:h2"] },
        { at: 5, build: 2, keys: ["run_a:h1"] },
      ],
    );
    expect(report.unanchored).toEqual(["run_a:h1", "run_a:h2", "run_a:h9"]);
  });
});

describe("planRunPaint", () => {
  /** A stand-in RelRange plus the absolute range the "binding" resolves it to. */
  function seg(keys: string[], at: { from: number; to: number } | null) {
    const rel = {} as RelRange;
    const hunks: PreviewHunkPart[] = keys.map((k) => ({
      runId: RUN,
      hunkId: k,
      key: itemKey(RUN, k),
      replacement: [],
      summary: `~ ${k}`,
    }));
    return { segment: { rel, hunks } as PreviewSegment, rel, at };
  }

  function plan(segs: ReturnType<typeof seg>[], unpaintable: HunkKey[] = []) {
    const data: RunPreviewData = {
      segments: segs.map((s) => s.segment),
      unpaintable,
    };
    const resolve = (rel: RelRange) => segs.find((s) => s.rel === rel)?.at ?? null;
    return planRunPaint(data, resolve);
  }

  it("anchors resolvable segments in document order", () => {
    const { placed, report } = plan([
      seg(["h2"], { from: 60, to: 80 }),
      seg(["h1"], { from: 4, to: 20 }),
    ]);
    expect(report).toEqual({ anchored: ["run_a:h1", "run_a:h2"], unanchored: [] });
    expect(placed).toHaveLength(2);
  });

  it("reports an ORPHANED anchor as unanchored rather than dropping the hunk", () => {
    const { placed, report } = plan([seg(["h1"], { from: 4, to: 20 }), seg(["h2"], null)]);
    expect(report).toEqual({ anchored: ["run_a:h1"], unanchored: ["run_a:h2"] });
    expect(placed.map((p) => p.keys)).toEqual([["run_a:h1"]]);
  });

  it("appends build-time unpaintable hunks after the positioned ones", () => {
    const { report } = plan(
      [seg(["h1"], { from: 4, to: 20 }), seg(["h2"], { from: 60, to: 80 })],
      ["run_a:h5"],
    );
    expect(report).toEqual({ anchored: ["run_a:h1", "run_a:h2"], unanchored: ["run_a:h5"] });
  });

  it("keeps a merged segment's hunks adjacent in the anchored order", () => {
    const { report } = plan([seg(["h1", "h2"], { from: 4, to: 20 }), seg(["h3"], { from: 60, to: 80 })]);
    expect(report.anchored).toEqual(["run_a:h1", "run_a:h2", "run_a:h3"]);
  });
});

describe("ghostWidgetKey", () => {
  it("distinguishes two segments of the SAME hunk", () => {
    expect(ghostWidgetKey(0, ["run_a:h1"])).not.toBe(ghostWidgetKey(1, ["run_a:h1"]));
  });

  it("distinguishes identically-named hunks of different runs", () => {
    expect(ghostWidgetKey(0, ["run_a:h1"])).not.toBe(ghostWidgetKey(0, ["run_b:h1"]));
  });

  it("changes when the ghost's RENDERED state does, so ProseMirror rebuilds it", () => {
    const p: PreviewHunkPart = {
      runId: RUN,
      hunkId: "h1",
      key: "run_a:h1",
      replacement: [],
      summary: "~ swift",
    };
    const ord = new Map([[p.key, 1]]);
    const idle = ghostVariant([p], ord, sameTotal(3, p.key), new Set());
    expect(ghostVariant([p], ord, sameTotal(3, p.key), new Set([p.key]))).not.toBe(idle); // in flight
    expect(ghostVariant([p], new Map([[p.key, 2]]), sameTotal(3, p.key), new Set())).not.toBe(idle); // reordered
    expect(ghostVariant([p], ord, sameTotal(4, p.key), new Set())).not.toBe(idle); // count grew
    expect(ghostVariant([{ ...p, summary: "~ sleepy" }], ord, sameTotal(3, p.key), new Set())).not.toBe(idle); // reworded
    expect(ghostVariant([p], ord, sameTotal(3, p.key), new Set())).toBe(idle); // stable otherwise
  });
});

// ---------------------------------------------------------------------------
// ghost DOM
// ---------------------------------------------------------------------------

describe("runGhost", () => {
  const blocks = () => topBlocks(markdownToDoc("A replacement paragraph.", schema));

  function part(over: Partial<PreviewHunkPart> = {}): PreviewHunkPart {
    return {
      runId: RUN,
      hunkId: "h1",
      key: itemKey(RUN, "h1"),
      replacement: blocks(),
      summary: "~ A replacement paragraph.",
      ...over,
    };
  }

  const ordinals = (...keys: HunkKey[]) => new Map(keys.map((k, i) => [k, i + 1]));

  it("renders the WORD form without the whole-block fill", () => {
    const p = part({
      words: [
        { type: "eq", text: "The " },
        { type: "del", text: "brown" },
        { type: "ins", text: "red" },
        { type: "eq", text: " fox" },
      ],
    });
    const el = runGhost([p], ordinals(p.key), sameTotal(3, p.key), new Set());
    expect(el.className).toContain("ai-preview-ghost--words");
    expect(el.className).not.toContain("ai-preview-insert--block");
    expect(el.querySelector("del")!.textContent).toBe("brown");
    expect(el.querySelector("ins")!.textContent).toBe("red");
    expect(el.textContent).toContain("The ");
  });

  it("renders the whole-block form when there are no word ops", () => {
    const p = part();
    const el = runGhost([p], ordinals(p.key), sameTotal(1, p.key), new Set());
    expect(el.className).toContain("ai-preview-insert--block");
    expect(el.querySelector("p")!.textContent).toBe("A replacement paragraph.");
  });

  it("tags each hunk with its key and names it for screen readers", () => {
    const p = part();
    const el = runGhost([p], ordinals(p.key), sameTotal(5, p.key), new Set());
    const hunkEl = el.querySelector<HTMLElement>("[data-hunk-key]")!;
    expect(hunkEl.dataset.hunkKey).toBe("run_a:h1");
    expect(hunkEl.getAttribute("aria-label")).toBe("Change 1 of 5: ~ A replacement paragraph.");
    const accept = el.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--accept")!;
    expect(accept.getAttribute("aria-label")).toBe("Accept change 1 of 5: ~ A replacement paragraph.");
  });

  it("gives a MERGED ghost one labelled section (with its own buttons) per hunk", () => {
    const a = part({ hunkId: "h1", key: "run_a:h1", summary: "~ swift" });
    const b = part({ hunkId: "h2", key: "run_a:h2", summary: "~ sleepy" });
    const el = runGhost([a, b], ordinals(a.key, b.key), sameTotal(2, a.key, b.key), new Set());
    expect(el.className).toContain("ai-preview-ghost--merged");
    const sections = el.querySelectorAll<HTMLElement>("[data-hunk-key]");
    expect(Array.from(sections).map((s) => s.dataset.hunkKey)).toEqual(["run_a:h1", "run_a:h2"]);
    expect(Array.from(el.querySelectorAll(".ai-preview-hunk-label")).map((n) => n.textContent)).toEqual([
      "~ swift",
      "~ sleepy",
    ]);
    expect(el.querySelectorAll(".ai-preview-hunk-btn")).toHaveLength(4);
  });

  it("omits the sub-label on a lone ghost (no chrome to attribute)", () => {
    const p = part();
    const el = runGhost([p], ordinals(p.key), sameTotal(1, p.key), new Set());
    expect(el.querySelector(".ai-preview-hunk-label")).toBeNull();
  });

  it("captions the agent when the part carries one", () => {
    const p = part({ agent: "Codex" });
    const el = runGhost([p], ordinals(p.key), sameTotal(1, p.key), new Set());
    expect(el.querySelector(".ai-preview-hunk-agent")!.textContent).toBe("Codex");
  });

  it("announces a click as a run-hunk decision carrying the run id", () => {
    const p = part();
    const el = runGhost([p], ordinals(p.key), sameTotal(1, p.key), new Set());
    document.body.appendChild(el);
    const seen: RunHunkDecisionDetail[] = [];
    const onEvt = (e: Event) => seen.push((e as CustomEvent<RunHunkDecisionDetail>).detail);
    document.addEventListener(RUN_HUNK_EVENT, onEvt);
    el.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--reject")!.click();
    document.removeEventListener(RUN_HUNK_EVENT, onEvt);
    el.remove();
    expect(seen).toEqual([{ runId: RUN, hunkId: "h1", decision: "reject" }]);
  });

  it("dims a hunk with a decision IN FLIGHT and refuses a second click", () => {
    const p = part();
    const el = runGhost([p], ordinals(p.key), sameTotal(1, p.key), new Set([p.key]));
    document.body.appendChild(el);
    const hunkEl = el.querySelector<HTMLElement>("[data-hunk-key]")!;
    expect(hunkEl.classList.contains("ai-preview-hunk--pending")).toBe(true);
    expect(hunkEl.getAttribute("aria-busy")).toBe("true");
    const accept = el.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--accept")!;
    expect(accept.disabled).toBe(true);

    const seen: RunHunkDecisionDetail[] = [];
    const onEvt = (e: Event) => seen.push((e as CustomEvent<RunHunkDecisionDetail>).detail);
    document.addEventListener(RUN_HUNK_EVENT, onEvt);
    accept.click();
    // jsdom honours `disabled` for click(), so check the handler itself bails too.
    accept.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.removeEventListener(RUN_HUNK_EVENT, onEvt);
    el.remove();
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// table-mounted ghosts are a <tr> whose one cell spans every column
// ---------------------------------------------------------------------------
describe("table-mounted ghosts", () => {
  const MD = docToMarkdown(
    markdownToDoc(
      [
        "Intro paragraph.",
        "",
        "| Level | Focus |",
        "| --- | --- |",
        "| Season | Why we keep the cottage |",
        "| Job | Which rooms come first |",
      ].join("\n"),
      schema,
    ),
  );

  function rowEdit() {
    const doc = markdownToDoc(MD, schema);
    const edits = computeStrEdits(MD, MD.replace("Why we keep the cottage", "Why we keep the cottage, checked yearly"), schema);
    expect(edits).toHaveLength(1);
    const { segments, unpaintable } = buildRunSegments(
      doc,
      MD,
      [hunk("h1", edits[0]!.old_string, edits[0]!.new_string)],
      schema,
    );
    expect(unpaintable).toEqual([]);
    expect(segments).toHaveLength(1);
    return { doc, seg: segments[0]! };
  }

  it("classifies a row segment's mount point as INSIDE the table, with its column count", () => {
    const { doc, seg } = rowEdit();
    expect(tableRowContext(doc, seg.from)).toBe(2);
    expect(tableRowContext(doc, 0)).toBeNull(); // doc level
    expect(tableRowContext(doc, 1)).toBeNull(); // inside the intro paragraph
  });

  it("wraps a table-mounted ghost in a real <tr> whose one cell spans the grid", () => {
    const { seg } = rowEdit();
    const p = seg.hunks[0]!;
    const el = runGhost([p], new Map([[p.key, 1]]), sameTotal(1, p.key), new Set(), undefined, undefined, 2);
    expect(el.tagName).toBe("TR");
    expect(el.className).toContain("ai-preview-ghost-row");
    const cell = el.querySelector<HTMLTableCellElement>("td.ai-preview-ghost-cell")!;
    expect(cell.colSpan).toBe(2);
    expect(cell.querySelector(".ai-preview-ghost")).not.toBeNull();
    expect(el.querySelector<HTMLElement>("[data-hunk-key]")!.dataset.hunkKey).toBe("run_a:h1");
    expect(el.querySelectorAll(".ai-preview-hunk-btn")).toHaveLength(2);
  });

  it("keeps the plain <div> form when the ghost is NOT table-mounted", () => {
    const { seg } = rowEdit();
    const p = seg.hunks[0]!;
    expect(runGhost([p], new Map([[p.key, 1]]), sameTotal(1, p.key), new Set()).tagName).toBe("DIV");
  });
});
