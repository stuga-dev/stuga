/**
 * Block-level diffing over ProseMirror documents.
 *
 * The accept path (`applyMarkdownToYXmlFragment`) and the inline preview both go
 * through `mergeTarget`, so the previewed change is exactly what Accept commits.
 */
import { Fragment } from "prosemirror-model";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { getStugaSchema } from "../schema.js";
import { markdownToDoc } from "../markdown/parse.js";
import { docToMarkdown } from "../markdown/serialize.js";

/** Direct children of any node, in order. */
function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.content.forEach((child) => out.push(child));
  return out;
}

/** Top-level blocks of a doc node, in order. */
export function topBlocks(doc: PMNode): PMNode[] {
  return childrenOf(doc);
}

/**
 * Does the diff descend into this node's children instead of treating it as one
 * block? Derived from the schema: any non-empty, non-textblock, non-leaf block
 * whose children are blocks — except a table row, the finest unit the table
 * serializer can write back.
 */
export function isDescendableContainer(node: PMNode): boolean {
  const type = node.type;
  if (!type.isBlock || type.isTextblock || type.isLeaf || type.isAtom) return false;
  if (node.childCount === 0) return false;
  if (!node.firstChild!.isBlock) return false;
  return type.spec.tableRole !== "row";
}

interface ChangedRun {
  startBlock: number;
  endBlock: number;
  replacement: PMNode[];
}

/**
 * Split a changed run into 1:1 replacements when both sides line up by type,
 * so two adjacent edited items are two reviewable changes. The pieces cover
 * exactly the same blocks; a run whose sides differ in length or type order
 * stays whole.
 */
function splitRun(base: PMNode[], run: ChangedRun): ChangedRun[] {
  const n = run.endBlock - run.startBlock;
  if (n < 2 || run.replacement.length !== n) return [run];
  for (let i = 0; i < n; i++) {
    if (base[run.startBlock + i]!.type !== run.replacement[i]!.type) return [run];
  }
  return Array.from({ length: n }, (_, i) => ({
    startBlock: run.startBlock + i,
    endBlock: run.startBlock + i + 1,
    replacement: [run.replacement[i]!],
  }));
}

/**
 * The container pair a run may be refined into, or null. `sameMarkup` is
 * required because descent only reports child changes, so an attr change on the
 * container itself (a list's `start`) would vanish.
 */
function descendPair(base: PMNode[], run: ChangedRun): [PMNode, PMNode] | null {
  if (run.endBlock - run.startBlock !== 1 || run.replacement.length !== 1) return null;
  const a = base[run.startBlock];
  const b = run.replacement[0];
  if (!a || !b) return null;
  if (!a.sameMarkup(b)) return null;
  if (!isDescendableContainer(a) || !isDescendableContainer(b)) return null;
  return [a, b];
}

/** Wrap a block list in a doc node (empty → a single empty paragraph). */
export function docNode(schema: Schema, children: PMNode[]): PMNode {
  const content = children.length
    ? Fragment.fromArray(children)
    : Fragment.fromArray([schema.nodes.paragraph!.create()]);
  return schema.topNodeType.create(null, content);
}

/** Number of leading blocks equal in both arrays (capped at `max`). */
function commonPrefix(a: PMNode[], b: PMNode[], max: number): number {
  let i = 0;
  while (i < max && a[i]!.eq(b[i]!)) i++;
  return i;
}
/** Number of trailing blocks equal in both arrays (capped at `max`). */
function commonSuffix(a: PMNode[], b: PMNode[], max: number): number {
  let i = 0;
  while (i < max && a[a.length - 1 - i]!.eq(b[b.length - 1 - i]!)) i++;
  return i;
}

/** Edit of a block sequence against a base: replace base[start,end) with `repl`. */
export function diffRegion(base: PMNode[], other: PMNode[]): { start: number; end: number; repl: PMNode[] } {
  const bound = Math.min(base.length, other.length);
  const pre = commonPrefix(base, other, bound);
  const suf = commonSuffix(base, other, bound - pre);
  return { start: pre, end: base.length - suf, repl: other.slice(pre, other.length - suf) };
}

/** A block the markdown projection drops (an empty paragraph), so live and projected block indices differ. */
function isProjectionInvisible(block: PMNode): boolean {
  return block.type.name === "paragraph" && block.content.size === 0;
}

/**
 * 3-way block merge. `original` and `proposed` are markdown projections, so they
 * are diffed against the live document's visible blocks, then the change is
 * mapped back onto the live blocks, keeping invisible ones outside the changed
 * range. Non-overlapping AI and human edits both survive; overlapping ones take
 * the proposal the user accepted.
 */
export function mergeTarget(schema: Schema, current: PMNode, original: PMNode, proposed: PMNode): PMNode {
  const liveBlocks = topBlocks(current);
  const orig = topBlocks(original);
  const prop = topBlocks(proposed);

  const visible: PMNode[] = [];
  const liveIndexOfVisible: number[] = [];
  liveBlocks.forEach((b, i) => {
    if (!isProjectionInvisible(b)) {
      visible.push(b);
      liveIndexOfVisible.push(i);
    }
  });
  // Nothing real to align to: the proposal replaces the document.
  if (visible.length === 0) return docNode(schema, prop);

  const ai = diffRegion(orig, prop);
  const human = diffRegion(orig, visible);

  let mergedVisible: PMNode[];
  if (ai.end <= human.start) {
    mergedVisible = [...orig.slice(0, ai.start), ...ai.repl, ...orig.slice(ai.end, human.start), ...human.repl, ...orig.slice(human.end)];
  } else if (human.end <= ai.start) {
    mergedVisible = [...orig.slice(0, human.start), ...human.repl, ...orig.slice(human.end, ai.start), ...ai.repl, ...orig.slice(ai.end)];
  } else {
    mergedVisible = prop;
  }

  // The live end is one past the last replaced visible block, so an invisible
  // block right after the change is kept; a pure insertion removes nothing.
  const chg = diffRegion(visible, mergedVisible);
  const liveStart = chg.start < liveIndexOfVisible.length ? liveIndexOfVisible[chg.start]! : liveBlocks.length;
  const liveEnd = chg.end === chg.start ? liveStart : liveIndexOfVisible[chg.end - 1]! + 1;
  const merged = [...liveBlocks.slice(0, liveStart), ...chg.repl, ...liveBlocks.slice(liveEnd)];
  return docNode(schema, merged);
}

/**
 * The change Accept will commit, as segments over `current` (a live document,
 * not a re-parse, so indices map onto it). Segments may be nested inside
 * containers; locate each with `resolveSegment` against the same `current`.
 *
 * `originalDoc` lets a caller diffing many proposals against one baseline parse
 * it once; it must be the parse of `originalMarkdown`.
 */
export function previewBlockSegments(
  current: PMNode,
  proposedMarkdown: string,
  originalMarkdown: string | null,
  schema: Schema = getStugaSchema(),
  originalDoc?: PMNode,
): BlockDiffSegment[] {
  const proposed = markdownToDoc(proposedMarkdown, schema);
  const target =
    originalMarkdown != null
      ? mergeTarget(schema, current, originalDoc ?? markdownToDoc(originalMarkdown, schema), proposed)
      : docNode(schema, topBlocks(proposed));
  return blockDiffSegments(topBlocks(current), topBlocks(target));
}

/**
 * One contiguous change: replace children [startBlock, endBlock) of the node at
 * `path` with `replacement`. `path` is the chain of child indices from the doc
 * root; `[]` is the doc itself, `[3]` the fourth top-level block's children.
 */
export interface BlockDiffSegment {
  startBlock: number;
  endBlock: number;
  replacement: PMNode[];
  path: number[];
}

/** A `BlockDiffSegment` located in a concrete document. */
export interface ResolvedSegment {
  /** Position just before the first replaced child. */
  from: number;
  /** Position just after the last replaced child (`from` for a pure insertion). */
  to: number;
  /** The node whose children the segment indexes. */
  parent: PMNode;
  /** The children the segment replaces (empty for a pure insertion). */
  removed: PMNode[];
}

/** Resolve a segment against the document it was computed from, or null when it no longer fits. */
export function resolveSegment(doc: PMNode, seg: BlockDiffSegment): ResolvedSegment | null {
  let parent = doc;
  // Where `parent`'s content starts: 0 for the doc, one past a node's open token otherwise.
  let base = 0;
  for (const idx of seg.path) {
    if (idx < 0 || idx >= parent.childCount) return null;
    let at = base;
    for (let i = 0; i < idx; i++) at += parent.child(i).nodeSize;
    parent = parent.child(idx);
    if (parent.isLeaf) return null;
    base = at + 1;
  }
  if (seg.startBlock < 0 || seg.endBlock < seg.startBlock || seg.endBlock > parent.childCount) return null;
  let from = base;
  for (let i = 0; i < seg.startBlock; i++) from += parent.child(i).nodeSize;
  let to = from;
  const removed: PMNode[] = [];
  for (let i = seg.startBlock; i < seg.endBlock; i++) {
    const child = parent.child(i);
    removed.push(child);
    to += child.nodeSize;
  }
  return { from, to, parent, removed };
}

/** Rebuild `root` with `repl` spliced over the children [start,end) at `path`. */
function replaceAtPath(root: PMNode, path: number[], start: number, end: number, repl: PMNode[]): PMNode {
  const kids = childrenOf(root);
  if (path.length === 0) {
    const next = [...kids.slice(0, start), ...repl, ...kids.slice(end)];
    // An emptied container is not a valid node; callers fall back to a whole-block change.
    if (next.length === 0) throw new Error("replaceAtPath: container emptied");
    return root.copy(Fragment.fromArray(next));
  }
  const [head, ...rest] = path;
  const child = kids[head!];
  if (!child) throw new Error("replaceAtPath: path out of range");
  kids[head!] = replaceAtPath(child, rest, start, end, repl);
  return root.copy(Fragment.fromArray(kids));
}

/**
 * Apply nested segments (all inside one top-level block, in document order) to
 * that block. Folded in reverse so every segment's base-tree indices are still
 * valid when it applies.
 */
export function applyNestedSegments(root: PMNode, segs: BlockDiffSegment[]): PMNode {
  let out = root;
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    out = replaceAtPath(out, s.path.slice(1), s.startBlock, s.endBlock, s.replacement);
  }
  return out;
}

type LcsStep = "eq" | "del" | "ins";

/** Block-level LCS (equality = structural `PMNode.eq`) as a step sequence. */
function lcsSteps(base: PMNode[], other: PMNode[]): LcsStep[] {
  const n = base.length;
  const m = other.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = base[i]!.eq(other[j]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const steps: LcsStep[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i]!.eq(other[j]!)) {
      steps.push("eq");
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      steps.push("del");
      i++;
    } else {
      steps.push("ins");
      j++;
    }
  }
  while (i < n) {
    steps.push("del");
    i++;
  }
  while (j < m) {
    steps.push("ins");
    j++;
  }
  return steps;
}

/**
 * Multi-region block diff, recursing into same-markup container pairs so a
 * change inside a list lands on the items that changed. Segments are disjoint
 * and in document order at every depth. Presentation and hunk generation only:
 * Accept still commits `mergeTarget`'s single splice.
 */
export function blockDiffSegments(base: PMNode[], other: PMNode[]): BlockDiffSegment[] {
  const segs: BlockDiffSegment[] = [];
  collectSegments(base, other, [], segs);
  return segs;
}

/**
 * The LCS coalesced into matched pairs and changed runs (`insStart` is a run's
 * first index in `other`). Shared by the segment and markdown diffs so both agree
 * on what counts as one change.
 */
type LcsWalkStep =
  | { kind: "eq"; bi: number; oi: number }
  | { kind: "run"; run: ChangedRun & { insStart: number } };

function lcsRuns(base: PMNode[], other: PMNode[]): LcsWalkStep[] {
  const out: LcsWalkStep[] = [];
  let bi = 0;
  let oi = 0;
  let open: (ChangedRun & { insStart: number }) | null = null;
  const flush = () => {
    if (!open) return;
    out.push({ kind: "run", run: open });
    open = null;
  };
  for (const step of lcsSteps(base, other)) {
    if (step === "eq") {
      flush();
      out.push({ kind: "eq", bi, oi });
      bi++;
      oi++;
      continue;
    }
    if (!open) open = { startBlock: bi, endBlock: bi, replacement: [], insStart: oi };
    if (step === "del") {
      open.endBlock = bi + 1;
      bi++;
    } else {
      open.replacement.push(other[oi]!);
      oi++;
    }
  }
  flush();
  return out;
}

function collectSegments(base: PMNode[], other: PMNode[], path: number[], out: BlockDiffSegment[]): void {
  for (const step of lcsRuns(base, other)) {
    if (step.kind === "eq") continue;
    for (const piece of splitRun(base, step.run)) {
      const pair = descendPair(base, piece);
      if (pair) {
        collectSegments(childrenOf(pair[0]), childrenOf(pair[1]), [...path, piece.startBlock], out);
        continue;
      }
      out.push({ startBlock: piece.startBlock, endBlock: piece.endBlock, replacement: piece.replacement, path });
    }
  }
}

/** One rendered block of a version diff: its markdown and whether it is unchanged, removed or added. */
export type BlockDiffMarkdown = { type: "eq" | "del" | "ins"; markdown: string };

/** Serialize sibling nodes wrapped in copies of their ancestors; `firstIndex` keeps ordered numbering honest. */
type WrapFn = (nodes: PMNode[], firstIndex: number) => string;

/** A copy of `parent` holding only `children`, an ordered list restarting at the first kept item's ordinal. */
function wrapChildren(parent: PMNode, children: PMNode[], firstIndex: number): PMNode {
  if (typeof parent.attrs.start === "number") {
    const start = (parent.attrs.start || 1) + firstIndex;
    return parent.type.create({ ...parent.attrs, start }, Fragment.fromArray(children), parent.marks);
  }
  return parent.copy(Fragment.fromArray(children));
}

/** Whether a node renders as markdown on its own. A table row cannot: the table serializer prints the whole grid. */
function rendersStandalone(node: PMNode): boolean {
  const role = node.type.spec.tableRole;
  return role === undefined || role === "table";
}

/**
 * May the markdown diff emit one block per child of this container? Only when
 * the content expression is a single repeated term (`listItem+`, `block+`), so
 * each child re-wrapped alone is a valid node. A list item (`paragraph block*`)
 * is emitted whole.
 */
function descendsForMarkdown(parent: PMNode): boolean {
  if (!rendersStandalone(parent.firstChild!)) return false;
  const content = parent.type.spec.content?.trim() ?? "";
  return content !== "" && !/\s/.test(content);
}

function collectMarkdownDiff(base: PMNode[], other: PMNode[], wrap: WrapFn, out: BlockDiffMarkdown[]): void {
  for (const step of lcsRuns(base, other)) {
    if (step.kind === "eq") {
      out.push({ type: "eq", markdown: wrap([base[step.bi]!], step.bi) });
      continue;
    }
    splitRun(base, step.run).forEach((piece, k) => {
      const seg = { ...piece, insStart: step.run.insStart + k };
      const pair = descendPair(base, seg);
      if (pair && descendsForMarkdown(pair[0])) {
        const [parent, otherParent] = pair;
        const at = seg.startBlock;
        collectMarkdownDiff(
          childrenOf(parent),
          childrenOf(otherParent),
          (nodes, firstIndex) => wrap([wrapChildren(parent, nodes, firstIndex)], at),
          out,
        );
        return;
      }
      for (let i = seg.startBlock; i < seg.endBlock; i++) out.push({ type: "del", markdown: wrap([base[i]!], i) });
      seg.replacement.forEach((r, i) => out.push({ type: "ins", markdown: wrap([r], seg.insStart + i) }));
    });
  }
}

/**
 * Block-level diff of two markdown documents as tagged blocks in reading order,
 * each re-serialized so it renders as rich text. Blocks match structurally, and
 * changed containers are descended into. Within a run, removals precede additions.
 */
export function blockDiffMarkdown(base: string, other: string, schema: Schema = getStugaSchema()): BlockDiffMarkdown[] {
  const baseBlocks = topBlocks(markdownToDoc(base, schema));
  const otherBlocks = topBlocks(markdownToDoc(other, schema));
  const out: BlockDiffMarkdown[] = [];
  collectMarkdownDiff(baseBlocks, otherBlocks, (nodes) => docToMarkdown(docNode(schema, nodes)), out);
  return out;
}
