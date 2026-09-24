/**
 * Where an agent run's pending hunks paint: pure placement, numbering and the
 * hunk-locality checks, with no DOM and no editor. A segment painted for hunk
 * `h` must be `h`'s own change, or it is not painted at all — a wrong ghost can
 * get a change accepted on the strength of a preview that misrepresents it.
 */
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import {
  previewBlockSegments,
  resolveSegment,
  wordDiff,
  markdownToDoc,
  applyStrEditsStrict,
  EDITOR_ONLY_ATTRS,
  type WordOp,
} from "@stuga/crdt-ops";
import { hash32 } from "../../lib/hash";
import type { RelRange } from "../rel-range";
import { summarizeHunk } from "../../review/hunk-review";
import { itemKey } from "../../review/run-ledger";

/**
 * Fired on `document` when a ghost's Accept/Reject is clicked. The buttons are
 * widget DOM outside the React tree, so this event is their way to the run
 * ledger provider.
 */
export const RUN_HUNK_EVENT = "stuga-run-hunk";

export interface RunHunkDecisionDetail {
  /** Hunk ids restart at "h1" in every run, so a decision needs both. */
  runId: string;
  hunkId: string;
  decision: "accept" | "reject";
}

/** A pending hunk's identity across runs: `itemKey(runId, hunkId)`. */
export type HunkKey = string;

/** The run half of a hunk key. Run ids contain no ":", so the first one separates. */
function runIdOf(key: HunkKey): string {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i);
}

/** The "of M" of each hunk's "change N of M": a merged ghost can hold hunks from runs with different totals. */
export type HunkTotals = ReadonlyMap<HunkKey, number>;

/** One agent-run hunk's contribution to a ghost. */
export interface PreviewHunkPart {
  runId: string;
  hunkId: string;
  key: HunkKey;
  /** Proposed blocks, for the whole-block ghost form. */
  replacement: PMNode[];
  /** Set when the hunk rewords one block into one block of the same type: render inline `<del>`/`<ins>`. */
  words?: WordOp[];
  /** Short human summary; the sub-label when one ghost carries several hunks. */
  summary: string;
  /** Agent display name, set only when more than one run is painted. */
  agent?: string;
}

/** One anchored structural change segment: strike its region, ghost its blocks. */
export interface PreviewSegment {
  /** The region being replaced, anchored to stable Yjs positions. */
  rel: RelRange;
  /** The hunks this segment's ghost renders; several when overlapping hunks were merged. */
  hunks: PreviewHunkPart[];
}

/** The resolved preview held in extension storage and rendered as decorations. */
export interface RunPreviewData {
  /** Disjoint segments; unchanged blocks between them stay unmarked. */
  segments: PreviewSegment[];
  /** Pending hunks with no segment (their text no longer matches uniquely); still decidable from the list. */
  unpaintable: HunkKey[];
}

/** What the last paint could and could not show, in document order. */
export interface RunReport {
  anchored: HunkKey[];
  unanchored: HunkKey[];
}

/**
 * Column count (colspans included) of the table `pos` sits directly in, or null.
 * A widget mounted among a table's rows must be a <tr>: a <div> there gets an
 * anonymous column-1 cell that stretches the live table's first column.
 */
export function tableRowContext(doc: PMNode, pos: number): number | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const parent = doc.resolve(pos).parent;
  if (parent.type.spec.tableRole !== "table") return null;
  let cols = 0;
  parent.firstChild?.content.forEach((cell) => {
    cols += typeof cell.attrs.colspan === "number" ? cell.attrs.colspan : 1;
  });
  return Math.max(1, cols);
}

/** Half-open overlap, with zero-width (pure insertion) ranges treated as points. */
export function rangesOverlap(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  if (a.from === a.to || b.from === b.to) return a.from <= b.to && b.from <= a.to;
  return a.from < b.to && b.from < a.to;
}

/**
 * Split a paint into anchored and unanchored hunks, both in document order
 * (ties by build order, so repaints are stable). A hunk appears once, at its
 * topmost segment, and counts as anchored if any of its segments painted.
 */
export function classifyRunHunks(
  placed: { from: number; build: number; keys: HunkKey[] }[],
  dropped: { at: number | null; build: number; keys: HunkKey[] }[],
): RunReport {
  const anchored: HunkKey[] = [];
  const seen = new Set<HunkKey>();
  for (const seg of [...placed].sort((a, b) => a.from - b.from || a.build - b.build)) {
    for (const key of seg.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      anchored.push(key);
    }
  }
  const unanchored: HunkKey[] = [];
  const sortAt = (v: number | null) => (v == null ? Number.POSITIVE_INFINITY : v);
  for (const seg of [...dropped].sort((a, b) => sortAt(a.at) - sortAt(b.at) || a.build - b.build)) {
    for (const key of seg.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      unanchored.push(key);
    }
  }
  return { anchored, unanchored };
}

/**
 * Decoration key for a ghost widget. ProseMirror reuses the DOM of equal keys,
 * so the key carries the build index (one hunk can paint several segments), the
 * hunk keys, and `variant`: everything else the ghost renders.
 */
export function ghostWidgetKey(build: number, keys: HunkKey[], variant = ""): string {
  return `ai-preview-ghost-${build}-${keys.join("+")}${variant ? `-${variant}` : ""}`;
}

/** The render-affecting state of one ghost, folded into its decoration key. */
export function ghostVariant(
  parts: PreviewHunkPart[],
  ordinals: Map<HunkKey, number>,
  total: HunkTotals,
  pendingKeys: ReadonlySet<HunkKey>,
): string {
  return parts
    .map((p) => {
      const shape = p.words ? `w${p.words.length}` : `b${p.replacement.length}`;
      const busy = pendingKeys.has(p.key) ? "!" : "";
      return `${ordinals.get(p.key) ?? 0}of${(total.get(p.key) ?? 0)}${busy}${shape}${hash32(p.summary + (p.agent ?? ""))}`;
    })
    .join(",");
}

/** A run segment that resolved to live positions and is going to be painted. */
interface PlacedRunSegment {
  from: number;
  to: number;
  build: number;
  keys: HunkKey[];
  parts: PreviewHunkPart[];
}

/** Decide what the overlay can show, and in what order. `resolve` stands in for the live Yjs binding. */
export function planRunPaint(
  data: RunPreviewData,
  resolve: (rel: RelRange) => { from: number; to: number } | null,
): { placed: PlacedRunSegment[]; report: RunReport } {
  const placed: PlacedRunSegment[] = [];
  const dropped: { at: number | null; build: number; keys: HunkKey[] }[] = [];

  data.segments.forEach((seg, build) => {
    const parts = seg.hunks;
    const keys = parts.map((p) => p.key);
    const range = resolve(seg.rel);
    if (!range) {
      dropped.push({ at: null, build, keys });
      return;
    }
    placed.push({ from: range.from, to: range.to, build, keys, parts });
  });
  for (const key of data.unpaintable) dropped.push({ at: null, build: Number.MAX_SAFE_INTEGER, keys: [key] });

  return { placed, report: classifyRunHunks(placed, dropped) };
}

/**
 * "Change N of M" for every hunk, numbered within its own run in the order the
 * run bar and change list use (anchored first, then unpaintable), so a change
 * has the same name everywhere.
 */
export function numberHunks(report: RunReport): {
  ordinals: Map<HunkKey, number>;
  totals: Map<HunkKey, number>;
} {
  const ordered = [...report.anchored, ...report.unanchored];
  const perRun = new Map<string, number>();
  for (const key of ordered) perRun.set(runIdOf(key), (perRun.get(runIdOf(key)) ?? 0) + 1);

  const ordinals = new Map<HunkKey, number>();
  const totals = new Map<HunkKey, number>();
  const counter = new Map<string, number>();
  for (const key of ordered) {
    const runId = runIdOf(key);
    const n = (counter.get(runId) ?? 0) + 1;
    counter.set(runId, n);
    ordinals.set(key, n);
    totals.set(key, perRun.get(runId) ?? n);
  }
  return { ordinals, totals };
}

/**
 * Eligible for a word-level diff: a pure-text textblock that is not code
 * (inline del/ins spans garble a code block).
 */
function isWordDiffable(node: PMNode): boolean {
  return (
    node.isTextblock &&
    node.type.name !== "codeBlock" &&
    node.textContent.length === node.content.size
  );
}

/** One pending agent-run hunk, as the ghost overlay needs it. */
export interface RunPreviewHunk {
  runId: string;
  id: string;
  old_string: string;
  new_string: string;
  /** Agent display name, shown on the ghost when more than one run is open. */
  agent?: string;
}

/** A run segment before it is anchored: live positions plus the hunks it renders. */
export interface RunSegmentDraft {
  from: number;
  to: number;
  hunks: PreviewHunkPart[];
}

/** The change list's summary as one string, so a ghost and its list row word a change identically. Render as text only. */
export function hunkSummary(oldStr: string, newStr: string): string {
  const s = summarizeHunk({ old_string: oldStr, new_string: newStr });
  return `${s.marker} ${s.text}`;
}

/**
 * Merge intersecting segments into one ghost with a labelled section per hunk,
 * so two hunks in one paragraph don't stack two identical full-block ghosts.
 * Adjacent but disjoint segments keep their own.
 */
export function mergeOverlapping(drafts: RunSegmentDraft[]): RunSegmentDraft[] {
  const sorted = [...drafts].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: RunSegmentDraft[] = [];
  for (const draft of sorted) {
    const open = out[out.length - 1];
    if (open && rangesOverlap(open, draft)) {
      open.to = Math.max(open.to, draft.to);
      for (const part of draft.hunks) {
        if (!open.hunks.some((p) => p.key === part.key)) open.hunks.push(part);
      }
      continue;
    }
    out.push({ from: draft.from, to: draft.to, hunks: [...draft.hunks] });
  }
  return out;
}

/*
 * A hunk's `old_string` is only guaranteed unique against the document as its
 * run's earlier hunks leave it. RunContext replays a run in order, tracking
 * which stretches are still verbatim baseline, so each hunk's match can be
 * located in the replay and mapped back to its one place in the baseline. A
 * match inside an earlier hunk's rewrite has no baseline position and stays
 * unpaintable.
 */

/** A stretch of the replayed text: a verbatim baseline slice, or inserted text. */
interface RunChunk {
  text: string;
  /** Offset in the baseline this text is a verbatim copy of; `-1` if inserted. */
  src: number;
}

/** One run's hunks replayed over the baseline, with a map back to it. */
interface RunContext {
  /** The baseline as the run's earlier hunks leave it. */
  text: string;
  chunks: RunChunk[];
}

function newRunContext(baseline: string): RunContext {
  return { text: baseline, chunks: baseline ? [{ text: baseline, src: 0 }] : [] };
}

/**
 * The stretch of `text` that `next` rewrites. Derived from the result, not the
 * hunk's `old_string`, because the strict apply matches quotes, dashes and NBSP
 * fuzzily.
 */
function changedRange(text: string, next: string): { from: number; to: number; insert: string } {
  const max = Math.min(text.length, next.length);
  let head = 0;
  while (head < max && text.charCodeAt(head) === next.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < max - head && text.charCodeAt(text.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail++;
  return { from: head, to: text.length - tail, insert: next.slice(head, next.length - tail) };
}

/** Where a range of the replayed text sits in the baseline — null if rewritten. */
function toBaselineRange(ctx: RunContext, from: number, to: number): { from: number; to: number } | null {
  let at = 0;
  for (const chunk of ctx.chunks) {
    const end = at + chunk.text.length;
    if (chunk.src >= 0 && from >= at && to <= end) return { from: chunk.src + (from - at), to: chunk.src + (to - at) };
    at = end;
  }
  // An append lands past the last chunk and maps only while the tail is still verbatim.
  const last = ctx.chunks[ctx.chunks.length - 1];
  if (from === to && from === ctx.text.length && last && last.src >= 0) {
    const end = last.src + last.text.length;
    return { from: end, to: end };
  }
  return null;
}

/** Replay one edit into the context, keeping the baseline map in step. */
function spliceRunContext(ctx: RunContext, from: number, to: number, insert: string): void {
  const out: RunChunk[] = [];
  let at = 0;
  for (const chunk of ctx.chunks) {
    const head = Math.min(chunk.text.length, Math.max(0, from - at));
    if (head > 0) out.push({ text: chunk.text.slice(0, head), src: chunk.src });
    at += chunk.text.length;
  }
  if (insert) out.push({ text: insert, src: -1 });
  at = 0;
  for (const chunk of ctx.chunks) {
    const end = at + chunk.text.length;
    const start = Math.max(at, to);
    if (start < end) {
      out.push({ text: chunk.text.slice(start - at), src: chunk.src < 0 ? -1 : chunk.src + (start - at) });
    }
    at = end;
  }
  ctx.chunks = out;
  ctx.text = ctx.text.slice(0, from) + insert + ctx.text.slice(to);
}

/**
 * The baseline rewritten by this hunk alone, or null if it cannot be placed.
 * Advances `ctx` whenever the hunk applies in sequence, even when unpaintable,
 * because later hunks are placed relative to it.
 */
function localizeHunk(ctx: RunContext, baseline: string, h: { old_string: string; new_string: string }): string | null {
  const seq = applyStrEditsStrict(ctx.text, [{ old_string: h.old_string, new_string: h.new_string }]);
  if (seq.conflicts.length === 0 && seq.markdown !== ctx.text) {
    const { from, to, insert } = changedRange(ctx.text, seq.markdown);
    const at = toBaselineRange(ctx, from, to);
    spliceRunContext(ctx, from, to, insert);
    if (at) return baseline.slice(0, at.from) + insert + baseline.slice(at.to);
  }
  // The replay couldn't place it; it may still match on its own against the untouched document.
  const alone = applyStrEditsStrict(baseline, [{ old_string: h.old_string, new_string: h.new_string }]);
  return alone.conflicts.length === 0 && alone.markdown !== baseline ? alone.markdown : null;
}

/**
 * A fingerprint of what the reader sees: types, text, marks and every attr
 * markdown can express, ignoring EDITOR_ONLY_ATTRS. The live document and
 * re-parsed markdown differ in those attrs, which must not read as a change.
 */
function renderedShape(nodes: readonly PMNode[]): string {
  const out: string[] = [];
  const attrsOf = (attrs: Record<string, unknown> | null): string =>
    Object.keys(attrs ?? {})
      .filter((k) => !EDITOR_ONLY_ATTRS.has(k))
      .sort()
      .map((k) => `${k}=${JSON.stringify((attrs ?? {})[k])}`)
      .join(",");
  const walk = (n: PMNode): void => {
    out.push(n.type.name, attrsOf(n.attrs));
    if (n.isText) {
      out.push(n.text ?? "", n.marks.map((m) => `${m.type.name}(${attrsOf(m.attrs)})`).join("|"));
    }
    n.content.forEach(walk);
    out.push("/");
  };
  nodes.forEach(walk);
  return out.join("\u0000");
}

/*
 * Hunk locality. The live document and re-parsed markdown can diverge where
 * markdown can't express something, and the merge then reports a large phantom
 * change for every hunk. So each segment is checked against the hunk that
 * produced it, and one that removes or inserts text the hunk never mentions is
 * not painted: a wrong ghost gets an unseen change accepted, a missing one only
 * sends the reviewer to the change list.
 */

/**
 * Letters and digits only, so hunk markdown and rendered text compare despite
 * syntax, separators and the parser's typography. Aggressive on purpose: a
 * false match is still bounded structurally, a false mismatch hides a real ghost.
 */
function localityText(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/** The rendered text of a run of nodes, with blocks and table cells kept apart. */
function nodesText(nodes: readonly PMNode[]): string {
  return nodes.map((n) => n.textBetween(0, n.content.size, " ", " ")).join(" ");
}

/**
 * How many markdown lines a run of nodes is worth, to compare with
 * `mdLineCount`. A table row is one line however many cells it holds.
 */
function blockSpan(nodes: readonly PMNode[]): number {
  let total = 0;
  const spanOf = (node: PMNode): number => {
    if (node.type.spec.tableRole === "row" || node.isTextblock || node.isLeaf || node.childCount === 0) return 1;
    let n = 0;
    node.content.forEach((child) => {
      n += spanOf(child);
    });
    return Math.max(1, n);
  };
  for (const node of nodes) total += spanOf(node);
  return total;
}

/** Non-blank lines of a markdown fragment — its block count, near enough. */
function mdLineCount(md: string): number {
  let n = 0;
  for (const line of md.split("\n")) if (line.trim()) n++;
  return n;
}

/** How many more lines than the hunk's markdown a segment may cover (a sentence's paragraph and its neighbour). */
const BLOCK_SLACK = 2;

/**
 * One side of a hunk as the locality check reads it: the markdown rendered, so
 * that what a link, an image or a footnote marker contributes to the document
 * is what it contributes here, then the raw markdown, in case a fragment
 * renders to less than it says (a lone footnote definition). The two are joined
 * by a character `localityText` can never produce, so no match spans them.
 *
 * Rendering matters: `[the docs](https://example.com)` puts a URL between two
 * words in the source and nothing between them in the document, so an
 * insertion that is contiguous on screen is not contiguous in the markdown.
 */
function hunkSideText(md: string, schema: Schema): string {
  let rendered = "";
  try {
    rendered = nodesText([markdownToDoc(md, schema)]);
  } catch {
    rendered = "";
  }
  return `${localityText(rendered)}\u0000${localityText(md)}`;
}

/**
 * Whether a segment is plausibly the change `hunk` describes: it may not cover
 * many more lines than the hunk, and every deletion must appear in
 * `old_string` and every insertion in `new_string`.
 */
export function segmentMatchesHunk(
  removed: readonly PMNode[],
  replacement: readonly PMNode[],
  hunk: { old_string: string; new_string: string },
  schema: Schema,
): boolean {
  if (blockSpan(removed) > mdLineCount(hunk.old_string) + BLOCK_SLACK) return false;
  if (blockSpan(replacement) > mdLineCount(hunk.new_string) + BLOCK_SLACK) return false;

  const oldText = hunkSideText(hunk.old_string, schema);
  const newText = hunkSideText(hunk.new_string, schema);
  for (const op of wordDiff(nodesText(removed), nodesText(replacement))) {
    if (op.type === "eq") continue;
    const changed = localityText(op.text);
    if (!changed) continue;
    if (!(op.type === "del" ? oldText : newText).includes(changed)) return false;
  }
  return true;
}

/**
 * Cap on one hunk's whole paint: individually plausible segments can still add
 * up to half the page. A hunk over the cap goes unanchored entirely, since a
 * partial paint understates what Accept writes.
 */
const MAX_SEGMENTS_PER_HUNK = 4;

export function exceedsHunkPaintCap(
  count: number,
  removedSpan: number,
  insertedSpan: number,
  hunk: { old_string: string; new_string: string },
): boolean {
  return (
    count > MAX_SEGMENTS_PER_HUNK ||
    removedSpan > mdLineCount(hunk.old_string) + BLOCK_SLACK ||
    insertedSpan > mdLineCount(hunk.new_string) + BLOCK_SLACK
  );
}

/**
 * Paintable segments for the pending hunks against the live document. Each hunk
 * gets its own preview (the document plus that hunk alone) so its ghost carries
 * its own Accept/Reject. `hunks` must be in each run's generated order, which is
 * the replay context; hunks that can't be placed come back in `unpaintable`.
 */
export function buildRunSegments(
  doc: PMNode,
  currentMd: string,
  hunks: RunPreviewHunk[],
  schema: Schema,
): { segments: RunSegmentDraft[]; unpaintable: HunkKey[] } {
  const showAgent = new Set(hunks.map((h) => h.runId)).size > 1;
  const drafts: RunSegmentDraft[] = [];
  const unpaintable: HunkKey[] = [];
  const contexts = new Map<string, RunContext>();
  const currentDoc = markdownToDoc(currentMd, schema);

  for (const h of hunks) {
    const key = itemKey(h.runId, h.id);
    let ctx = contexts.get(h.runId);
    if (!ctx) {
      ctx = newRunContext(currentMd);
      contexts.set(h.runId, ctx);
    }
    const proposedMd = localizeHunk(ctx, currentMd, h);
    if (proposedMd === null) {
      unpaintable.push(key);
      continue;
    }
    const base: Omit<PreviewHunkPart, "replacement" | "words"> = {
      runId: h.runId,
      hunkId: h.id,
      key,
      summary: hunkSummary(h.old_string, h.new_string),
      ...(showAgent && h.agent ? { agent: h.agent } : {}),
    };
    const mine: RunSegmentDraft[] = [];
    let removedSpan = 0;
    let insertedSpan = 0;
    for (const seg of previewBlockSegments(doc, proposedMd, currentMd, schema, currentDoc)) {
      const at = resolveSegment(doc, seg);
      if (!at) continue;
      if (renderedShape(at.removed) === renderedShape(seg.replacement)) continue;
      if (!segmentMatchesHunk(at.removed, seg.replacement, h, schema)) continue;
      const oldBlock = at.removed.length === 1 ? at.removed[0]! : null;
      const newBlock = seg.replacement.length === 1 ? seg.replacement[0]! : null;
      const words =
        oldBlock && newBlock && oldBlock.type === newBlock.type && isWordDiffable(oldBlock) && isWordDiffable(newBlock)
          ? wordDiff(oldBlock.textContent, newBlock.textContent)
          : undefined;
      removedSpan += blockSpan(at.removed);
      insertedSpan += blockSpan(seg.replacement);
      mine.push({
        from: at.from,
        to: at.to,
        hunks: [{ ...base, replacement: seg.replacement, ...(words ? { words } : {}) }],
      });
    }
    if (mine.length === 0 || exceedsHunkPaintCap(mine.length, removedSpan, insertedSpan, h)) {
      unpaintable.push(key);
      continue;
    }
    drafts.push(...mine);
  }
  return { segments: mergeOverlapping(drafts), unpaintable };
}
