// @vitest-environment jsdom
/**
 * Run segments over live documents built through Yjs, where the live
 * ProseMirror doc can differ from `markdownToDoc(currentMd)` in ways markdown
 * can't express. The paint must stay one honest ghost per hunk, or none.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import {
  applyMarkdownToYXmlFragment,
  applyStrEditsStrict,
  computeStrEdits,
  docToMarkdown,
  getStugaSchema,
  markdownToDoc,
  previewBlockSegments,
  resolveSegment,
  topBlocks,
  yXmlFragmentToMarkdown,
} from "@stuga/crdt-ops";
import {
  buildRunSegments,
  exceedsHunkPaintCap,
  segmentMatchesHunk,
  type RunPreviewHunk,
  type RunSegmentDraft,
} from "./plan";
import { itemKey } from "../../review/run-ledger";

const schema = getStugaSchema();
const RUN = "run_a";

/** A live document as the editor gets it through Yjs, plus the markdown projection hunks anchor in. */
function liveFromMarkdown(md: string): { doc: PMNode; currentMd: string } {
  const ydoc = new Y.Doc();
  const frag = ydoc.getXmlFragment("default");
  applyMarkdownToYXmlFragment(frag, md, { schema, origin: { agent: "importer" } });
  const doc = yXmlFragmentToProseMirrorRootNode(frag, schema) as PMNode;
  return { doc, currentMd: yXmlFragmentToMarkdown(frag, schema) };
}

/** The proposed text one ghost section renders. */
function renderedText(part: { words?: { type: string; text: string }[]; replacement: PMNode[] }): string {
  if (part.words) return part.words.filter((w) => w.type !== "del").map((w) => w.text).join("");
  return part.replacement.map((n) => n.textContent).join(" ⏎ ");
}

// A long spec: tables with full-sentence and marked cells, checkbox bullets,
// a nested list, an ordered list, headings and inline marks.

const SPEC_MD = [
  "# Cottage Upkeep Handbook",
  "",
  "This handbook is the one record of how cottage work is planned, sized and done.",
  "",
  "## 2. Kinds of Work",
  "",
  "| Level | Meaning | Inherits | Owner |",
  "| --- | --- | --- | --- |",
  "| Season | A season-long plan with its own budget | Nothing; it is the root of the tree | Warden |",
  "| Area | Groups the Jobs that finish one Season | Season | Caretaker |",
  "| **Job** | Inherits the area and links the Season's site map; keeps only its own sketch/log and dated checkpoints | Area | Foreman |",
  "| Task | The smallest piece of work a guest would notice on its own | Job | Crew |",
  "",
  "### 2.1 Sizing Rule of Thumb",
  "",
  "**1–2** = really a Task itself, or its \"Tasks\" are chores in disguise.",
  "",
  "## 3. Planning Cadence",
  "",
  "| Cadence | Layer | Estimation unit | Output |",
  "| --- | --- | --- | --- |",
  "| Yearly | 0 · Charter & Purpose | — | Five-year note / letter: why we keep it |",
  "| Quarterly | 1 · Season plan | seasons | Budgets and season plans |",
  "| Bi-weekly | 4 · Work | points (§4.4) | One cycle |",
  "",
  "### 4.4 Sizing Method (Task Points)",
  "",
  "Task points are a *relative* measure of effort agreed by the whole crew at the walk-through.",
  "",
  "* **Grain:** round to the nearest **whole person-day** before booking.",
  "",
  "* **Carry-over:** anything not Done at cycle close goes back on the list.",
  "",
  "## 5. Ready to Start",
  "",
  "* [ ] Task has a clear visible result",
  "",
  "* [ ] Task is `Walked` and estimated in points",
  "",
  "* [ ] Finish checks are written down",
  "",
  "* [ ] Safety plan agreed with the Warden",
  "",
  "  * [ ] Nearby rooms named",
  "",
  "* [ ] Photos attached",
  "",
  "## 6. Record Keeping",
  "",
  "| Record | Question it answers | Keeper |",
  "| --- | --- | --- |",
  "| Charter | Why do we keep the cottage at all | Trustees |",
  "| Task | What a guest will notice | Host + Lead |",
  "| `Log` | Which shortcut did we accept | Foreman |",
  "",
  "## 7. Gatherings",
  "",
  "| # | Gathering | Trigger | Outcome |",
  "| --- | --- | --- | --- |",
  "| 4 | Planning | At cycle start: pull from the top of the list | Booked work |",
  "| 5 | Walk-through | At the Saturday walk-through: review the next two cycles | Sized list |",
  "",
  "### 7.1 Order of Business",
  "",
  "1. Review the carry-over from the previous cycle.",
  "",
  "2. Re-estimate anything that changed shape.",
  "",
  "3. Agree on the cycle goal.",
  "",
  "## 8. Task (the cycle's sizing unit)",
  "",
  "A task is the smallest unit that leaves the cottage better on its own.",
].join("\n");

/** Seven scattered edits, one of them in a table. */
function proposalFrom(md: string): string {
  return md
    .replace("| Bi-weekly | 4 · Work | points (§4.4) |", "| Bi-weekly | 4 · Work | days (§4.4) |")
    .replace("4.4 Sizing Method (Task Points)", "4.4 Sizing Method (Work Days)")
    .replace("Task points are a", "Task sizes are a")
    .replace("round to the nearest **whole person-day**", "round to the nearest **half person-day**")
    .replace("Task is `Walked` and estimated in points", "Task is `Walked` and estimated in days")
    .replace("Photos attached", "Photos attached and reviewed")
    .replace(
      "A task is the smallest unit that leaves the cottage better on its own.",
      "A task is the smallest **bookable** unit that leaves the cottage better on its own.",
    );
}

describe("a real agent run over a CRDT-derived document", () => {
  const { doc: liveDoc, currentMd } = liveFromMarkdown(SPEC_MD);

  const proposalMd = proposalFrom(currentMd);

  const HUNKS: RunPreviewHunk[] = computeStrEdits(currentMd, proposalMd, schema).map((e, i) => ({
    runId: RUN,
    id: `h${i + 1}`,
    old_string: e.old_string,
    new_string: e.new_string,
  }));

  it("mints one pending hunk per changed location (fixture sanity)", () => {
    expect(proposalMd).not.toBe(currentMd);
    expect(HUNKS.length).toBeGreaterThanOrEqual(6);
  });

  it("the live CRDT doc and its own markdown projection describe the same document", () => {
    // Names the first block that differs, if any.
    const reparsed = markdownToDoc(currentMd, schema);
    /** Every marked text run of a block, so a mark-only difference is visible. */
    const marked = (node: PMNode): string => {
      const out: string[] = [];
      node.descendants((n) => {
        if (n.isText && n.marks.length > 0) out.push(`${n.marks.map((m) => m.type.name).join("+")}:${n.text}`);
        return true;
      });
      return out.join(", ") || "(no marks)";
    };
    const differing: string[] = [];
    const n = Math.max(liveDoc.childCount, reparsed.childCount);
    for (let i = 0; i < n; i++) {
      const a = liveDoc.maybeChild(i);
      const b = reparsed.maybeChild(i);
      if (!a || !b || !a.eq(b)) {
        differing.push(
          `block ${i} (${a?.type.name ?? "—"}): live marks [${a ? marked(a) : "—"}] vs projected marks [${b ? marked(b) : "—"}]`,
        );
      }
    }
    expect(differing).toEqual([]);
  });

  it("gives every hunk its own ghost", () => {
    const { segments, unpaintable } = buildRunSegments(liveDoc, currentMd, HUNKS, schema);

    expect(unpaintable).toEqual([]);
    // Every hunk edits a different block, so every segment holds exactly one.
    const stacked = segments
      .filter((s) => s.hunks.length > 1)
      .map((s) => ({
        at: `${s.from}..${s.to}`,
        hunks: s.hunks.map((p) => p.key),
        renders: s.hunks.map(renderedText),
      }));
    expect(stacked).toEqual([]);

    expect(segments.map((s) => s.hunks.map((p) => p.key))).toEqual(
      HUNKS.map((h) => [itemKey(h.runId, h.id)]),
    );

    const rendered = segments.flatMap((s) => s.hunks).map(renderedText);
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(rendered.filter((t) => t.includes("Inherits the area"))).toEqual([]);
  });
});

/** Table cells keep their inline marks, so the live doc can equal its own projection. */
describe("markdown projection of a table cell", () => {
  it("must keep inline marks, or the live doc can never equal its own projection", () => {
    const md = ["| Level | Meaning |", "| --- | --- |", "| **Job** | keeps its own `Log` |", ""].join("\n");
    const live = markdownToDoc(md, schema);
    const projection = docToMarkdown(live);
    expect(projection).toContain("| **Job** |");
    expect(markdownToDoc(projection, schema).eq(live)).toBe(true);
  });
});

/** A document imported from non-canonical markdown, with mark-bearing tables around the hunks. */
describe("a run over a document imported from non-canonical markdown", () => {
  const RAW_MD = [
    "# Cottage Upkeep Handbook",
    "",
    "| Level | Meaning | Owner |",
    "|:------|:--------------------------------------------|------:|",
    "| Season | A season-long plan with its own purse | Warden |",
    "| **Job** | Inherits the area and links the Season's site map; keeps only its own sketch/log and dated checkpoints | Foreman |",
    "| Task | The smallest piece of work a guest would notice | Crew |",
    "",
    "## Cadence",
    "",
    "Work cycles run for two weeks and close on a Sunday.",
    "",
    "- [ ] Task has a clear visible result",
    "- [ ] Task is `Walked` and estimated in points",
    "- [ ] Finish checks are written down",
    "",
    "### Estimation",
    "",
    "Task points are a *relative* measure of effort.",
    "",
    "| Record | Question it answers | Keeper |",
    "|---|---|---|",
    "| Charter | Why do we keep the cottage at all | Trustees |",
    "| Task | What a guest will notice | Host + Lead |",
    "",
    "A task is the smallest unit that leaves the cottage better on its own.",
  ].join("\n");

  const { doc: liveDoc, currentMd } = liveFromMarkdown(RAW_MD);

  const proposalMd = currentMd
    .replace("Work cycles run for two weeks", "Work cycles run for three weeks")
    .replace("Task is `Walked` and estimated in points", "Task is `Walked` and estimated in days")
    .replace("Finish checks are written down", "Finish checks are written down and linked")
    .replace("Task points are a *relative* measure of effort.", "Task sizes are an *absolute* measure of effort.")
    .replace("| Host + Lead |", "| Host + Lead Carpenter |")
    .replace(
      "A task is the smallest unit that leaves the cottage better on its own.",
      "A task is the smallest **bookable** unit that leaves the cottage better on its own.",
    );

  const HUNKS: RunPreviewHunk[] = computeStrEdits(currentMd, proposalMd, schema).map((e, i) => ({
    runId: RUN,
    id: `h${i + 1}`,
    old_string: e.old_string,
    new_string: e.new_string,
  }));

  it("keeps one ghost per changed location while the divergence stays above them", () => {
    // The projection is its own round trip.
    expect(currentMd).toBe(docToMarkdown(markdownToDoc(currentMd, schema)));
    const { segments, unpaintable } = buildRunSegments(liveDoc, currentMd, HUNKS, schema);
    expect(unpaintable).toEqual([]);
    const stacked = segments
      .filter((s) => s.hunks.length > 1)
      .map((s) => ({ at: `${s.from}..${s.to}`, hunks: s.hunks.map((p) => p.key), renders: s.hunks.map(renderedText) }));
    expect(stacked).toEqual([]);
    const rendered = segments.flatMap((s) => s.hunks).map(renderedText);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("paints ONE ghost for a hunk that edits the mark-bearing table itself", () => {
    const one: RunPreviewHunk[] = [
      {
        runId: RUN,
        id: "h1",
        old_string: "| Task | The smallest piece of work a guest would notice | Crew |",
        new_string: "| Task | The smallest piece of work a guest would notice in one cycle | Crew |",
      },
    ];
    const { segments, unpaintable } = buildRunSegments(liveDoc, currentMd, one, schema);
    expect(unpaintable).toEqual([]);
    expect(segments.map((s) => s.hunks.map(renderedText))).toEqual([
      ["TaskThe smallest piece of work a guest would notice in one cycleCrew"],
    ]);
  });
});

// Hunk locality: a segment painted for hunk h must be h's own change. A hunk
// that can't be painted honestly stays listed as unanchored.

/** A long document with several tables and lists. */
const FIELD_MD = [
  "# Cottage Upkeep Handbook",
  "",
  "The handbook below is **normative**: where a crew's local habit disagrees with it, this handbook wins.",
  "",
  "## 2. Kinds of Work",
  "",
  "| Level | Meaning | Inherits | Owner |",
  "| --- | --- | --- | --- |",
  "| Season | A season-long plan with its own budget (§2.1) | Nothing; it is the root | Warden |",
  "| **Job** | Inherits the area and links the Season's site map (§2.2); keeps only its own sketch/log | Area | Foreman |",
  "| Task | The smallest piece of work a guest would notice on its own — sized in points (§4.4) | **Job** | Crew |",
  "",
  "### 2.1 Splitting Rule",
  "",
  "A Task that needs “>8 steps” is not a Task — it is a Job wearing a `Task` label, and it goes back to the walk-through.",
  "",
  "## 4. Planning Cadence",
  "",
  "| Cadence | Layer | Estimation unit | Output |",
  "| --- | --- | --- | --- |",
  "| Yearly | 0 · Charter | — | Five-year letter: **why** we keep it |",
  "| Quarterly | 1 · Season plan | seasons | Budgets and season plans |",
  "| Bi-weekly | 4 · Work | points (§4.4) | One cycle of booked work |",
  "",
  "### 4.4 Sizing Method (Task Points)",
  "",
  "Task points are a *relative* measure of effort agreed by the whole crew — never a promise of hours.",
  "",
  "* **Grain:** round to the nearest **whole person-day** before booking.",
  "",
  "* **Carry-over:** anything not `Done` at cycle close goes back on the list.",
  "",
  "## 5. Ready to Start",
  "",
  "* [ ] Task has a clear visible result",
  "",
  "* [ ] Task is `Walked` and estimated in points",
  "",
  "* [ ] Finish checks are written down",
  "",
  "* [ ] Photos attached",
  "",
  "## 6. Record Keeping",
  "",
  "| Record | Question it answers | Keeper |",
  "| --- | --- | --- |",
  "| Charter | Why do we keep the cottage at all | Trustees |",
  "| `Log` | Which shortcut did we accept, and **when** | Foreman |",
  "",
  "## 7. Closing",
  "",
  "A task is the smallest unit that leaves the cottage better on its own.",
].join("\n");

/** Seven edits, each in a different part of the document. */
function fieldProposal(md: string): string {
  return md
    .replace("The handbook below is **normative**", "The handbook below is **binding**")
    .replace("A Task that needs “>8 steps”", "A Task that needs “>5 steps”")
    .replace("4.4 Sizing Method (Task Points)", "4.4 Sizing Method (Work Days)")
    .replace("Task points are a *relative* measure", "Task sizes are an *absolute* measure")
    .replace("round to the nearest **whole person-day**", "round to the nearest **half person-day**")
    .replace("Task is `Walked` and estimated in points", "Task is `Walked` and estimated in days")
    .replace("Photos attached", "Photos attached and reviewed")
    .replace(
      "A task is the smallest unit that leaves the cottage better on its own.",
      "A task is the smallest **bookable** unit that leaves the cottage better on its own.",
    );
}

/** Text no hunk names; it must never appear in a hunk's strike or ghost. */
const UNTOUCHED = [
  "Inherits the area and links the Season",
  "A season-long plan with its own budget",
  "Why do we keep the cottage at all",
  "Which shortcut did we accept",
  "Budgets and season plans",
  "Finish checks are written down",
  "anything not",
];

/** Compare markdown against rendered text without tripping over notation. */
const words = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

interface Audit {
  /** One row per painted (segment, hunk) pair. */
  painted: { key: string; struck: string; ghosted: string }[];
  unpaintable: string[];
  segments: RunSegmentDraft[];
}

function audit(doc: PMNode, currentMd: string, hunks: RunPreviewHunk[]): Audit {
  const { segments, unpaintable } = buildRunSegments(doc, currentMd, hunks, schema);
  const painted = segments.flatMap((s) =>
    s.hunks.map((p) => ({
      key: p.key,
      struck: doc.textBetween(s.from, s.to, " ", " "),
      ghosted: renderedText(p),
    })),
  );
  return { painted, unpaintable, segments };
}

/** The locality invariant, which must hold whether or not the round trip is faithful. */
function expectHonestPaint(a: Audit, hunks: RunPreviewHunk[]): void {
  const byKey = new Map(hunks.map((h) => [itemKey(h.runId, h.id), h]));

  // Every pending hunk is painted or listed, exactly once.
  const keys = hunks.map((h) => itemKey(h.runId, h.id)).sort();
  const seen = [...new Set([...a.painted.map((p) => p.key), ...a.unpaintable])].sort();
  expect(seen).toEqual(keys);
  expect(a.unpaintable).toEqual([...new Set(a.unpaintable)]);
  // A key is never BOTH painted and listed as unpaintable.
  expect(a.painted.filter((p) => a.unpaintable.includes(p.key))).toEqual([]);

  // No two boxes render the same content.
  const ghosts = a.painted.map((p) => p.ghosted).filter((t) => t.trim().length > 0);
  expect(new Set(ghosts).size).toBe(ghosts.length);

  // 3. Nothing a hunk never mentioned may be struck or ghosted by it.
  const trespass = a.painted.flatMap((p) => {
    const h = byKey.get(p.key)!;
    return UNTOUCHED.filter(
      (phrase) =>
        (words(p.struck).includes(words(phrase)) || words(p.ghosted).includes(words(phrase))) &&
        !words(h.old_string + h.new_string).includes(words(phrase)),
    ).map((phrase) => `${p.key} covers untouched text: ${phrase}`);
  });
  expect(trespass).toEqual([]);

  // What a ghost proposes is attributable to its hunk's new_string plus unchanged context.
  const foreign = a.painted.filter((p) => {
    const h = byKey.get(p.key)!;
    const changed = words(p.ghosted).replace(words(p.struck), "");
    return changed.length > 0 && !words(h.new_string).includes(changed) && !words(p.struck).includes(words(p.ghosted));
  });
  expect(foreign.map((p) => `${p.key}: ${p.ghosted}`)).toEqual([]);
}

describe("a run over a long document with several tables", () => {
  const { doc: liveDoc, currentMd } = liveFromMarkdown(FIELD_MD);
  const proposalMd = fieldProposal(currentMd);
  const HUNKS: RunPreviewHunk[] = computeStrEdits(currentMd, proposalMd, schema).map((e, i) => ({
    runId: RUN,
    id: `h${i + 1}`,
    old_string: e.old_string,
    new_string: e.new_string,
  }));

  it("mints six or more hunks in six or more places (fixture sanity)", () => {
    expect(proposalMd).not.toBe(currentMd);
    expect(HUNKS.length).toBeGreaterThanOrEqual(6);
  });

  it("paints every hunk honestly, or not at all", () => {
    const a = audit(liveDoc, currentMd, HUNKS);
    expectHonestPaint(a, HUNKS);
  });

  it("anchors the hunks it can, and does not silently lose the rest", () => {
    const a = audit(liveDoc, currentMd, HUNKS);
    // With a faithful round trip every hunk is paintable.
    expect(a.unpaintable).toEqual([]);
    expect(a.painted).toHaveLength(HUNKS.length);
  });
});

describe("the same run over a live doc whose round trip cannot be faithful", () => {
  /**
   * A line break in a table cell has no markdown syntax, so the live doc
   * permanently differs from its projection and the merge emits phantom regions.
   */
  function withBreakInCell(table: PMNode): PMNode {
    const rows: PMNode[] = [];
    table.forEach((row) => {
      const cells: PMNode[] = [];
      row.forEach((cell, _offset, i) => {
        if (i !== 1) {
          cells.push(cell);
          return;
        }
        const para = cell.child(0);
        const broken = para.type.create(
          para.attrs,
          para.content.addToEnd(schema.nodes.hardBreak!.create()).addToEnd(schema.text("(reviewed)")),
          para.marks,
        );
        cells.push(cell.type.create(cell.attrs, Fragment.fromArray([broken]), cell.marks));
      });
      rows.push(row.type.create(row.attrs, Fragment.fromArray(cells), row.marks));
    });
    return table.type.create(table.attrs, Fragment.fromArray(rows), table.marks);
  }

  const { doc: cleanDoc, currentMd } = liveFromMarkdown(FIELD_MD);
  const liveDoc = (() => {
    const kids = topBlocks(cleanDoc);
    for (const i of kids.keys()) if (kids[i]!.type.name === "table") kids[i] = withBreakInCell(kids[i]!);
    return schema.topNodeType.create(null, Fragment.fromArray(kids));
  })();
  const proposalMd = fieldProposal(currentMd);
  const HUNKS: RunPreviewHunk[] = computeStrEdits(currentMd, proposalMd, schema).map((e, i) => ({
    runId: RUN,
    id: `h${i + 1}`,
    old_string: e.old_string,
    new_string: e.new_string,
  }));

  it("really does diverge from its own markdown projection (fixture sanity)", () => {
    expect(markdownToDoc(currentMd, schema).eq(liveDoc)).toBe(false);
    expect(markdownToDoc(currentMd, schema).eq(cleanDoc)).toBe(true); // ONLY the quirk differs
  });

  it("still hands buildRunSegments phantom regions to reject (fixture sanity)", () => {
    // The merge itself still reports the untouched tables as changed, so the fixture exercises the filter.
    const h = HUNKS.find((x) => x.old_string.includes("Photos attached"))!;
    const applied = applyStrEditsStrict(currentMd, [{ old_string: h.old_string, new_string: h.new_string }]);
    expect(applied.conflicts).toEqual([]);
    const raw = previewBlockSegments(liveDoc, applied.markdown, currentMd, schema);
    const phantom = raw
      .map((s) => resolveSegment(liveDoc, s))
      .filter((at) => at && liveDoc.textBetween(at.from, at.to, " ", " ").includes("(reviewed)"));
    expect(raw.length).toBeGreaterThan(1);
    expect(phantom.length).toBeGreaterThan(0);
  });

  it("still never paints a ghost that misrepresents its hunk", () => {
    const a = audit(liveDoc, currentMd, HUNKS);
    expectHonestPaint(a, HUNKS);
  });

  it("keeps every real change anchored and drops every phantom", () => {
    const a = audit(liveDoc, currentMd, HUNKS);
    // The genuine changes still paint, one box each,
    expect(a.unpaintable).toEqual([]);
    expect(a.painted).toHaveLength(HUNKS.length);
    // and nothing lands on either table.
    expect(a.painted.filter((p) => p.struck.includes("(reviewed)"))).toEqual([]);
  });

  it("never strikes a region spanning most of the document", () => {
    const a = audit(liveDoc, currentMd, HUNKS);
    const docSize = liveDoc.content.size;
    for (const s of a.segments) expect(s.to - s.from).toBeLessThan(docSize * 0.4);
    // No hunk may go missing from the review UI while it is being withheld.
    expect([...a.painted.map((p) => p.key), ...a.unpaintable].length).toBeGreaterThanOrEqual(HUNKS.length);
  });
});

describe("segmentMatchesHunk", () => {
  const hunk = {
    old_string: "| Bi-weekly | 4 · Work | points (§4.4) | One cycle of booked work |",
    new_string: "| Bi-weekly | 4 · Work | days (§4.4) | One cycle of booked work |",
  };
  const blocks = (md: string): PMNode[] => topBlocks(markdownToDoc(md, schema));

  it("accepts the segment that really is the hunk's change", () => {
    const removed = blocks("Sized in points (§4.4) over one cycle of booked work.");
    const added = blocks("Sized in days (§4.4) over one cycle of booked work.");
    expect(segmentMatchesHunk(removed, added, hunk, schema)).toBe(true);
  });

  it("accepts a whole block for a hunk that names one phrase inside it", () => {
    const h = { old_string: "estimated in points", new_string: "estimated in days" };
    expect(
      segmentMatchesHunk(
        blocks("Task is `Walked` and estimated in points before the cycle starts."),
        blocks("Task is `Walked` and estimated in days before the cycle starts."),
        h,
        schema,
      ),
    ).toBe(true);
  });

  it("rejects a section-sized strike for a one-row hunk", () => {
    const removed = blocks(
      [
        "### 4.4 Sizing Method (Task Points)",
        "",
        "Task points are a *relative* measure of effort agreed by the whole crew.",
        "",
        "| Record | Question it answers | Keeper |",
        "| --- | --- | --- |",
        "| Charter | Why do we keep the cottage at all | Trustees |",
        "| `Log` | Which shortcut did we accept | Foreman |",
        "",
        "A task is the smallest unit that leaves the cottage better on its own.",
      ].join("\n"),
    );
    expect(segmentMatchesHunk(removed, blocks("Task points are a *relative* measure."), hunk, schema)).toBe(false);
  });

  it("rejects a whole section whose text differs only by the hunk's words", () => {
    const section = (unit: string) =>
      [
        "### 4.4 Sizing Method",
        "",
        "Task sizing is agreed by the whole crew at the walk-through.",
        "",
        "| Cadence | Layer | Estimation unit | Output |",
        "| --- | --- | --- | --- |",
        "| Yearly | 0 · Charter | — | Five-year letter |",
        `| Bi-weekly | 4 · Work | ${unit} (§4.4) | One cycle of booked work |`,
        "",
        "A task is the smallest unit that leaves the cottage better on its own.",
      ].join("\n");
    const removed = blocks(section("points"));
    const added = blocks(section("days"));
    // The only textual difference is the hunk's change,
    expect(removed.map((n) => n.textContent).join()).not.toBe(added.map((n) => n.textContent).join());
    // yet a one-row hunk does not rewrite a section.
    expect(segmentMatchesHunk(removed, added, hunk, schema)).toBe(false);
    // The row on its own is exactly what this hunk changes.
    const row = (unit: string) =>
      blocks(
        [
          "| Cadence | Layer | Estimation unit | Output |",
          "| --- | --- | --- | --- |",
          `| Bi-weekly | 4 · Work | ${unit} (§4.4) | One cycle of booked work |`,
        ].join("\n"),
      );
    expect(segmentMatchesHunk(row("points"), row("days"), hunk, schema)).toBe(true);
  });

  it("rejects a right-sized segment on the wrong block", () => {
    expect(
      segmentMatchesHunk(
        blocks("Why do we keep the cottage at all — the Charter answers that, and nothing else does."),
        blocks("Why do we keep the cottage at all — the Deed answers that, and nothing else does."),
        hunk,
        schema,
      ),
    ).toBe(false);
  });

  it("rejects a ghost proposing content the hunk never wrote", () => {
    expect(
      segmentMatchesHunk(
        blocks("Sized in points (§4.4) over one cycle."),
        blocks("Sized in points (§4.4) over one cycle, pending a log entry from the Foreman."),
        hunk,
        schema,
      ),
    ).toBe(false);
  });

  it("is not defeated by markdown notation, section refs, dashes or curly quotes", () => {
    const h = {
      old_string: "A Task that needs “>8 steps” is not a Task — it is a **Job** wearing a `Task` label",
      new_string: "A Task that needs “>5 steps” is not a Task — it is a **Job** wearing a `Task` label",
    };
    expect(
      segmentMatchesHunk(
        blocks("A Task that needs “>8 steps” is not a Task — it is a **Job** wearing a `Task` label."),
        blocks("A Task that needs “>5 steps” is not a Task — it is a **Job** wearing a `Task` label."),
        h,
        schema,
      ),
    ).toBe(true);
  });

  it("is not defeated by a link's target, which sits between two words in the markdown and nowhere on the page", () => {
    const h = {
      old_string: "Read the notes.",
      new_string: "Read [the notes](https://example.com/q3-notes) before the review.",
    };
    expect(segmentMatchesHunk(blocks("Read the notes."), blocks("Read [the notes](https://example.com/q3-notes) before the review."), h, schema)).toBe(
      true,
    );
  });

  it("is not defeated by an image, whose alt text and URL render as nothing", () => {
    const h = {
      old_string: "1+1=2",
      new_string: "1+1=2\n\n## Today’s news\n\n![Rally in Sanaa](/api/docs/d1/media/abc \"AP Photo\")\n\n* **Missile intercepted.** No casualties reported. [AP](https://apnews.com/article/x-24211a3b)",
    };
    expect(
      segmentMatchesHunk(
        [],
        blocks(
          ["## Today’s news", "", "![Rally in Sanaa](/api/docs/d1/media/abc \"AP Photo\")", "", "* **Missile intercepted.** No casualties reported. [AP](https://apnews.com/article/x-24211a3b)"].join(
            "\n",
          ),
        ),
        h,
        schema,
      ),
    ).toBe(true);
  });

  it("still rejects an insertion the hunk never wrote, links and all", () => {
    const h = {
      old_string: "Read the notes.",
      new_string: "Read [the notes](https://example.com/q3-notes) before the review.",
    };
    expect(
      segmentMatchesHunk(blocks("Read the notes."), blocks("Read [the notes](https://example.com/q3-notes) and the [budget](https://example.com/budget)."), h, schema),
    ).toBe(false);
  });
});

describe("exceedsHunkPaintCap", () => {
  const hunk = { old_string: "estimated in points", new_string: "estimated in days" };

  it("allows one hunk's handful of regions", () => {
    expect(exceedsHunkPaintCap(2, 2, 2, hunk)).toBe(false);
  });

  it("refuses a hunk that claims regions all over the document", () => {
    // Inside the structural bound, so only the count refuses it.
    expect(exceedsHunkPaintCap(5, 3, 3, hunk)).toBe(true);
    expect(exceedsHunkPaintCap(4, 3, 3, hunk)).toBe(false);
  });

  it("refuses a couple of regions that TOGETHER dwarf the hunk's own markdown", () => {
    expect(exceedsHunkPaintCap(2, 14, 2, hunk)).toBe(true);
    expect(exceedsHunkPaintCap(2, 2, 14, hunk)).toBe(true);
  });

  it("scales its slack with a hunk that legitimately spans many lines", () => {
    const table = {
      old_string: ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "| 5 | 6 |"].join("\n"),
      new_string: ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 9 |", "| 5 | 6 |"].join("\n"),
    };
    expect(exceedsHunkPaintCap(1, 5, 5, table)).toBe(false);
  });
});

// One word renamed in five places, two of them identical checklist lines.

/**
 * A long handbook with everything a real one has: a footnote, GFM tables whose
 * cells carry bold text and section refs, em dashes, typographic quotes, inline
 * code, checkbox lists and a bullet list.
 */
const HANDBOOK_MD = [
  "# Cottage Upkeep Handbook",
  "",
  "This handbook is the one record of how cottage work is planned, sized and done — it is **normative**.[^1]",
  "",
  "[^1]: Where a crew's local habit disagrees with it, this handbook wins.",
  "",
  "## 2. Kinds of Work",
  "",
  "| Level | Meaning | Estimation unit | Owner |",
  "| --- | --- | --- | --- |",
  "| Season | A season-long plan with its own budget (§2.1) | — | Warden |",
  "| **Job** | Inherits the area and links the Season's site map (§2.2) | seasons | Foreman |",
  "| Task | The smallest piece of work a guest would notice — sized in points (§4.4) | points | Crew |",
  "",
  "### 2.1 Splitting Rule",
  "",
  "A Task that needs “>8 steps” is not a Task — it is a **Job** wearing a `Task` label, and it goes back to the walk-through.",
  "",
  "## 4. Planning Cadence",
  "",
  "| Cadence | Layer | Unit | Output |",
  "| --- | --- | --- | --- |",
  "| Yearly | 0 · Charter | — | Five-year letter: **why** we keep it |",
  "| Quarterly | 1 · Season plan | seasons | Budgets and season plans |",
  "| Bi-weekly | 4 · Work | points | One cycle of booked work |",
  "",
  "### 4.4 Sizing Method",
  "",
  "(Points) Tasks are estimated in **points**, a *relative* measure of effort agreed by the whole crew at the walk-through.",
  "",
  "* **Grain:** round to the nearest **whole person-day** before booking.",
  "",
  "* **Carry-over:** anything not `Done` at cycle close goes back on the list.",
  "",
  "## 5. Ready to Start",
  "",
  "* [ ] Task has a clear visible result",
  "",
  "* [ ] Task is `Walked` and estimated in points",
  "",
  "* [ ] Finish checks are written down",
  "",
  "## 6. Done Means",
  "",
  "* [ ] Task is `Walked` and estimated in points",
  "",
  "* [ ] Photos attached and reviewed",
  "",
  "## 7. Closing",
  "",
  "A task is the smallest unit that leaves the cottage better on its own.",
].join("\n");

/** The five places the rename touches, in serializer-canonical markdown (checkbox brackets escaped). */
const RENAMES: [find: string, replace: string][] = [
  // A table row whose other cells carry bold text, a section ref and an em dash.
  [
    "| Task | The smallest piece of work a guest would notice — sized in points (§4.4) | points | Crew |",
    "| Task | The smallest piece of work a guest would notice — sized in days (§4.4) | days | Crew |",
  ],
  // One cell of a second table.
  [
    "| Bi-weekly | 4 · Work | points | One cycle of booked work |",
    "| Bi-weekly | 4 · Work | days | One cycle of booked work |",
  ],
  // Prose with a bold run inside it.
  ["(Points) Tasks are estimated in **points**,", "(Days) Tasks are estimated in **days**,"],
  // The same line in two checklists: the second hunk is unique only in run order.
  [
    "## 5. Ready to Start\n\n* \\[ \\] Task has a clear visible result\n\n* \\[ \\] Task is `Walked` and estimated in points",
    "## 5. Ready to Start\n\n* \\[ \\] Task has a clear visible result\n\n* \\[ \\] Task is `Walked` and estimated in days",
  ],
  [
    "## 6. Done Means\n\n* \\[ \\] Task is `Walked` and estimated in points",
    "## 6. Done Means\n\n* \\[ \\] Task is `Walked` and estimated in days, and ticked off daily",
  ],
];

describe("an agent run that renames one word in five places", () => {
  const { doc: liveDoc, currentMd } = liveFromMarkdown(HANDBOOK_MD);
  const proposalMd = RENAMES.reduce((md, [find, replace]) => {
    expect(md).toContain(find);
    return md.replace(find, replace);
  }, currentMd);

  const HUNKS: RunPreviewHunk[] = computeStrEdits(currentMd, proposalMd, schema).map((e, i) => ({
    runId: RUN,
    id: `h${i + 1}`,
    old_string: e.old_string,
    new_string: e.new_string,
  }));

  it("mints five short hunks over a doc that equals its own projection", () => {
    expect(proposalMd).not.toBe(currentMd);
    expect(markdownToDoc(currentMd, schema).eq(liveDoc)).toBe(true);
    expect(HUNKS).toHaveLength(5);
    for (const h of HUNKS) expect(h.old_string.length).toBeLessThan(200);
  });

  it("mints hunks that each anchor uniquely on their own, not just in run order", () => {
    const sequential = applyStrEditsStrict(
      currentMd,
      HUNKS.map((h) => ({ old_string: h.old_string, new_string: h.new_string })),
    );
    expect(sequential.conflicts).toEqual([]);
    expect(sequential.markdown).toBe(proposalMd);
    // Every hunk is also unique alone, so accepting one hunk by id applies cleanly.
    const ambiguous = HUNKS.filter(
      (h) =>
        applyStrEditsStrict(currentMd, [{ old_string: h.old_string, new_string: h.new_string }]).conflicts.length > 0,
    );
    expect(ambiguous.map((h) => h.id)).toEqual([]);
  });

  it("anchors every hunk", () => {
    const { segments, unpaintable } = buildRunSegments(liveDoc, currentMd, HUNKS, schema);
    expect(unpaintable).toEqual([]);
    const painted = segments.flatMap((s) => s.hunks.map((p) => p.key));
    expect([...painted].sort()).toEqual(HUNKS.map((h) => itemKey(h.runId, h.id)).sort());
  });

  it("paints each hunk at its own distinct location", () => {
    const { segments } = buildRunSegments(liveDoc, currentMd, HUNKS, schema);
    expect(segments).toHaveLength(5);
    for (const s of segments) expect(s.hunks).toHaveLength(1);
    expect(new Set(segments.map((s) => `${s.from}..${s.to}`)).size).toBe(5);
    // In document order and never overlapping.
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.from).toBeGreaterThanOrEqual(segments[i - 1]!.to);
    // Each strike really is the text its hunk names.
    const struck = segments.map((s) => liveDoc.textBetween(s.from, s.to, " ", " "));
    for (const text of struck) expect(text.toLowerCase()).toContain("points");
  });

  it("gives each ghost its own replacement content — no two boxes agree", () => {
    const { segments } = buildRunSegments(liveDoc, currentMd, HUNKS, schema);
    const rendered = segments.flatMap((s) => s.hunks).map(renderedText);
    expect(rendered).toHaveLength(5);
    expect(new Set(rendered).size).toBe(rendered.length);
    for (const text of rendered) expect(text).toContain("days");
    for (const text of rendered) {
      expect(text).not.toContain("Inherits the area");
      expect(text).not.toContain("Budgets and season plans");
      expect(text).not.toContain("Finish checks");
    }
  });

  it("puts each nearly-identical checklist line on its own checklist", () => {
    const { segments } = buildRunSegments(liveDoc, currentMd, HUNKS, schema);
    const onLists = segments.filter((s) =>
      liveDoc.textBetween(s.from, s.to, " ", " ").includes("Task is Walked and estimated in points"),
    );
    expect(onLists).toHaveLength(2);
    /** The whole list a segment sits in, so a swapped pair is visible. */
    const listAround = (from: number): string => {
      const list = liveDoc.resolve(from).node(1);
      return list.textBetween(0, list.content.size, " ", " ");
    };
    expect(listAround(onLists[0]!.from)).toContain("clear visible result");
    expect(listAround(onLists[1]!.from)).toContain("Photos attached");
    expect(renderedText(onLists[1]!.hunks[0]!)).toContain("ticked off daily");
    expect(renderedText(onLists[0]!.hunks[0]!)).not.toContain("ticked off daily");
  });
});

describe("a hunk whose old_string is only unique in its run's order", () => {
  // Hand-written hunks: h2 is unique once h1 has run, and ambiguous against the untouched document.
  const MD = ["Alpha", "", "Sized in points.", "", "Beta", "", "Sized in points.", ""].join("\n");
  const { doc: liveDoc, currentMd } = liveFromMarkdown(MD);
  const HUNKS: RunPreviewHunk[] = [
    { runId: RUN, id: "h1", old_string: "Alpha\n\nSized in points.", new_string: "Alpha\n\nSized in days." },
    { runId: RUN, id: "h2", old_string: "Sized in points.", new_string: "Sized in days." },
  ];

  it("is ambiguous alone and unique in sequence (fixture sanity)", () => {
    expect(applyStrEditsStrict(currentMd, [HUNKS[1]!]).conflicts).toEqual([0]);
    expect(applyStrEditsStrict(currentMd, HUNKS).conflicts).toEqual([]);
  });

  it("anchors on the second paragraph, the one the run's order gives it", () => {
    const { segments, unpaintable } = buildRunSegments(liveDoc, currentMd, HUNKS, schema);
    expect(unpaintable).toEqual([]);
    expect(segments).toHaveLength(2);
    // The lines are identical, so only where the ghosts sit differs.
    const textBefore = (from: number): string => liveDoc.textBetween(0, from, " ", " ");
    expect(textBefore(segments[0]!.from)).not.toContain("Beta");
    expect(textBefore(segments[1]!.from)).toContain("Beta");
  });

  it("still refuses a hunk that no order can place", () => {
    const only: RunPreviewHunk[] = [
      { runId: RUN, id: "h1", old_string: "Sized in points.", new_string: "Sized in days." },
    ];
    const { segments, unpaintable } = buildRunSegments(liveDoc, currentMd, only, schema);
    expect(segments).toEqual([]);
    expect(unpaintable).toEqual(["run_a:h1"]);
  });

  it("keeps two open runs out of each other's context", () => {
    // h2 is unique only after its own run's h1.
    const twoRuns: RunPreviewHunk[] = [
      { runId: "run_a", id: "h1", old_string: "Alpha\n\nSized in points.", new_string: "Alpha\n\nSized in days." },
      { runId: "run_b", id: "h1", old_string: "Sized in points.", new_string: "Sized in days." },
    ];
    const { segments, unpaintable } = buildRunSegments(liveDoc, currentMd, twoRuns, schema);
    expect(unpaintable).toEqual(["run_b:h1"]);
    expect(segments.flatMap((s) => s.hunks.map((p) => p.key))).toEqual(["run_a:h1"]);
  });

  it("does not let an earlier hunk's rewrite invent a position for a later one", () => {
    const dependent: RunPreviewHunk[] = [
      { runId: RUN, id: "h1", old_string: "Alpha\n\nSized in points.", new_string: "Alpha\n\nSized in days." },
      { runId: RUN, id: "h2", old_string: "Sized in days.", new_string: "Sized in half-days." },
    ];
    const { segments, unpaintable } = buildRunSegments(liveDoc, currentMd, dependent, schema);
    expect(unpaintable).toEqual(["run_a:h2"]);
    expect(segments.flatMap((s) => s.hunks.map((p) => p.key))).toEqual(["run_a:h1"]);
  });
});
