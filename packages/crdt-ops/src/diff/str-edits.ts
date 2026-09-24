/**
 * Markdown str_edits: applying them, strictly applying them, and generating the
 * minimal set that turns one document into another.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import { findFuzzyMatch } from "@stuga/protocol/text/fuzzy-match";
import { getStugaSchema } from "../schema.js";
import { markdownToDoc } from "../markdown/parse.js";
import { docToMarkdown } from "../markdown/serialize.js";
import { applyNestedSegments, blockDiffSegments, docNode, topBlocks } from "./blocks.js";

/** One surgical edit: replace old_string, or append when it is "". */
export interface StrEditOp {
  old_string: string;
  new_string: string;
}

/**
 * Apply surgical edits in order. Each replaces the first fuzzy match of its
 * old_string (the matcher the agent validates with, so smart quotes and dashes
 * still match); an empty old_string appends; an edit that no longer matches is
 * skipped. The accept path and the preview both apply through here.
 */
export function applyStrEdits(markdown: string, edits: StrEditOp[]): string {
  let out = markdown;
  for (const e of edits) {
    if (e.old_string === "") {
      out = out + e.new_string;
      continue;
    }
    const m = findFuzzyMatch(out, e.old_string);
    if (m) out = out.slice(0, m.index) + e.new_string + out.slice(m.index + m.matched.length);
  }
  return out;
}

/** Result of `applyStrEditsStrict`: the text plus which edit indices landed. */
export interface StrictApplyResult {
  markdown: string;
  /** Indices (into `edits`) that applied. */
  applied: number[];
  /** Indices whose old_string no longer matched — skipped, not fatal. */
  conflicts: number[];
}

/**
 * `applyStrEdits` that reports which edits applied and requires each match to be
 * unique. The review path applies arbitrary subsets of a run's hunks (accept one,
 * revert in reverse), where an old_string can match twice; taking the first hit
 * would rewrite the wrong paragraph, so ambiguity is a conflict like no match.
 */
export function applyStrEditsStrict(markdown: string, edits: StrEditOp[]): StrictApplyResult {
  let out = markdown;
  const applied: number[] = [];
  const conflicts: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    if (e.old_string === "") {
      out = out + e.new_string;
      applied.push(i);
      continue;
    }
    const m = findFuzzyMatch(out, e.old_string, { wantUnique: true });
    if (m) {
      out = out.slice(0, m.index) + e.new_string + out.slice(m.index + m.matched.length);
      applied.push(i);
    } else {
      conflicts.push(i);
    }
  }
  return { markdown: out, applied, conflicts };
}

/** One computed find/replace hunk (see `computeStrEdits`). */
export interface ComputedHunk {
  old_string: string;
  new_string: string;
}

/** Most per-child hunks one container contributes before it counts as one rewrite. */
const MAX_NESTED_HUNKS = 32;

/** Exact occurrences of `needle`, counted up to `cap`: every caller only distinguishes 0, 1 and more. */
function countExact(haystack: string, needle: string, cap = 2): number {
  if (needle === "") return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    n++;
    if (n >= cap) return n;
    at = haystack.indexOf(needle, at + 1);
  }
  return n;
}

/**
 * Eq blocks (context candidates) and change hunks. `chain` marks hunks that are
 * successive states of one top-level block (`[list⁰ → list¹]`, `[list¹ → list²]`),
 * so each item change is its own reviewable hunk. Chained hunks overlap, so they
 * must collapse to `[list⁰ → listⁿ]` before any neighbour merging.
 */
type DiffPart =
  | { kind: "eq"; node: PMNode }
  | { kind: "hunk"; dels: PMNode[]; ins: PMNode[]; chain?: number };

/** The eq-block run immediately before/after parts[i] (document order). */
function eqRunBefore(parts: DiffPart[], i: number): PMNode[] {
  const out: PMNode[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const p = parts[j]!;
    if (p.kind !== "eq") break;
    out.unshift(p.node);
  }
  return out;
}
function eqRunAfter(parts: DiffPart[], i: number): PMNode[] {
  const out: PMNode[] = [];
  for (let j = i + 1; j < parts.length; j++) {
    const p = parts[j]!;
    if (p.kind !== "eq") break;
    out.push(p.node);
  }
  return out;
}

/**
 * Merge parts[idx] with its nearest neighbouring hunk, carrying the eq blocks
 * between them on both sides. Null when there is no neighbour left.
 */
function mergeHunkWithNeighbor(parts: DiffPart[], idx: number): DiffPart[] | null {
  let other = -1;
  for (let j = idx + 1; j < parts.length; j++) {
    if (parts[j]!.kind === "hunk") {
      other = j;
      break;
    }
  }
  if (other < 0) {
    for (let j = idx - 1; j >= 0; j--) {
      if (parts[j]!.kind === "hunk") {
        other = j;
        break;
      }
    }
  }
  if (other < 0) return null;
  const lo = Math.min(idx, other);
  const hi = Math.max(idx, other);
  const dels: PMNode[] = [];
  const ins: PMNode[] = [];
  for (let j = lo; j <= hi; j++) {
    const p = parts[j]!;
    if (p.kind === "eq") {
      dels.push(p.node);
      ins.push(p.node);
    } else {
      dels.push(...p.dels);
      ins.push(...p.ins);
    }
  }
  return [...parts.slice(0, lo), { kind: "hunk", dels, ins }, ...parts.slice(hi + 1)];
}

/** Collapse chained hunks back into the single hunk they add up to (`only`: one chain id). */
function collapseChains(parts: DiffPart[], only?: number): DiffPart[] {
  const out: DiffPart[] = [];
  for (let i = 0; i < parts.length; ) {
    const p = parts[i]!;
    if (p.kind !== "hunk" || p.chain === undefined || (only !== undefined && p.chain !== only)) {
      out.push(p);
      i++;
      continue;
    }
    let j = i;
    let last = p;
    while (j + 1 < parts.length) {
      const q = parts[j + 1]!;
      if (q.kind !== "hunk" || q.chain !== p.chain) break;
      j++;
      last = q;
    }
    out.push({ kind: "hunk", dels: p.dels, ins: last.ins });
    i = j + 1;
  }
  return out;
}

/** Split into lines, each keeping its own "\n" (the last one may lack it). */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/**
 * Shrink an anchored hunk to the lines that changed: trim the common leading and
 * trailing lines, then grow context back one line at a time until the old string
 * is unique in both `working` (the document with predecessors applied) and `base`
 * (so the hunk can be decided alone, in any order).
 *
 * Safe because the untrimmed old string occurs exactly once in `working`, so a
 * unique trimmed candidate lies inside it and yields the same document; growth is
 * bounded by the original hunk. Both uniqueness checks run together because the
 * smallest candidate satisfying one is often not the smallest satisfying both.
 */
function minimizeHunk(working: string, hunk: ComputedHunk, base: string): ComputedHunk {
  const o = splitLines(hunk.old_string);
  const n = splitLines(hunk.new_string);
  const bound = Math.min(o.length, n.length);
  let pre = 0;
  while (pre < bound && o[pre] === n[pre]) pre++;
  let suf = 0;
  while (suf < bound - pre && o[o.length - 1 - suf] === n[n.length - 1 - suf]) suf++;
  if (pre === 0 && suf === 0) return hunk;
  // Smallest first; among equal sizes prefer preceding context, so anchors read in document order.
  for (let grow = 0; grow <= pre + suf; grow++) {
    for (let before = Math.min(grow, pre); before >= 0; before--) {
      const after = grow - before;
      if (after > suf) continue;
      const oldStr = o.slice(pre - before, o.length - (suf - after)).join("");
      // An empty old_string means "append" — never a valid in-place anchor.
      if (oldStr === "") continue;
      const newStr = n.slice(pre - before, n.length - (suf - after)).join("");
      if (oldStr === newStr) continue;
      if (countExact(working, oldStr) !== 1) continue;
      if (countExact(base, oldStr) !== 1) continue;
      return { old_string: oldStr, new_string: newStr };
    }
  }
  return hunk;
}

/**
 * Build the edit list, simulating each apply. Each old string must be unique in
 * `working` (so the sequential apply lands where simulated) and in `base` (so
 * the reviewer can decide the hunk alone against the live document). Returns the
 * edits, or the index of the part that could not be anchored.
 */
function buildEdits(base: string, parts: DiffPart[], mdOf: (nodes: PMNode[]) => string): ComputedHunk[] | number {
  const edits: ComputedHunk[] = [];
  let working = base;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.kind !== "hunk") continue;
    const eqBefore = eqRunBefore(parts, i);
    const eqAfter = eqRunAfter(parts, i);
    // A hunk with an empty side anchors on an adjacent eq block, because the "\n\n"
    // between blocks belongs to neither: an insertion has nothing of its own to
    // find, and a bare deletion would leave both separators behind.
    const emptySide = part.dels.length === 0 || part.ins.length === 0;
    const maxK = eqBefore.length + eqAfter.length;
    const minK = emptySide && maxK > 0 ? 1 : 0;
    // A pure deletion borrows the following block first: `<block>\n\nnext → next`
    // minimizes to just the deleted lines, while the preceding block never trims.
    const preferAfter = part.ins.length === 0 && part.dels.length > 0;
    let found: ComputedHunk | null = null;
    outer: for (let k = minK; k <= maxK; k++) {
      const bs: number[] = [];
      for (let b = Math.min(k, eqBefore.length); b >= 0; b--) bs.push(b);
      if (preferAfter) bs.reverse();
      for (const b of bs) {
        const a = k - b;
        if (a > eqAfter.length) continue;
        const ctxB = b > 0 ? eqBefore.slice(eqBefore.length - b) : [];
        const ctxA = eqAfter.slice(0, a);
        const oldStr = mdOf([...ctxB, ...part.dels, ...ctxA]);
        const newStr = mdOf([...ctxB, ...part.ins, ...ctxA]);
        if (oldStr === "") {
          // Only valid in an empty document; elsewhere "" appends instead of replacing.
          if (working === "" && base === "") {
            found = { old_string: "", new_string: newStr };
            break outer;
          }
          continue;
        }
        const count = countExact(working, oldStr);
        // Not literally present (non-canonical markdown): more context cannot help.
        if (count === 0) return i;
        // count > 1: keep growing context until unique.
        if (count > 1) continue;
        if (oldStr === newStr) {
          // A no-op hunk is dropped below and needs no anchor.
          found = { old_string: oldStr, new_string: newStr };
          break outer;
        }
        // The trimmed form is what ships, so it must be unique in `base`; if even
        // the widest trim is not, one more neighbouring block is cheaper than
        // collapsing the chain or merging hunks.
        const candidate = minimizeHunk(working, { old_string: oldStr, new_string: newStr }, base);
        if (countExact(base, candidate.old_string) !== 1) continue;
        found = candidate;
        break outer;
      }
    }
    if (!found) return i;
    if (found.old_string === found.new_string) continue; // no-op hunk
    // Exactly what applyStrEdits does (an exact match is findFuzzyMatch's first pass).
    if (found.old_string === "") {
      working = working + found.new_string;
    } else {
      const at = working.indexOf(found.old_string);
      working = working.slice(0, at) + found.new_string + working.slice(at + found.old_string.length);
    }
    edits.push(found);
  }
  return edits;
}

/**
 * Block-level str_edits turning `base` into `next`. Guarantees:
 *  - `applyStrEdits(base, result) === next`, verified before returning; anything
 *    else falls back to one whole-document hunk;
 *  - every non-empty old_string occurs exactly once when applied and exactly once
 *    in `base`, so any hunk can be decided alone and in any order;
 *  - an insertion anchors on an adjacent block ("" only for an empty document);
 *  - each hunk covers only the lines that differ plus the context uniqueness
 *    needs. Inserting into or removing from an ordered list rewrites the
 *    renumbered tail, because the serializer numbers from `start`.
 *
 * Diffed with `blockDiffSegments`, descending into containers, so two edits in
 * one list are two hunks. Hunks anchor exactly only on serializer-canonical
 * markdown. Escalation when a hunk cannot anchor: grow context, collapse its
 * chain, collapse all chains, merge with a neighbour, whole document.
 */
export function computeStrEdits(base: string, next: string, schema: Schema = getStugaSchema()): ComputedHunk[] {
  if (base === next) return [];
  // Always correct: a non-empty base occurs once in itself; an empty base appends.
  const wholeDoc = (): ComputedHunk[] => [{ old_string: base, new_string: next }];

  let parts: DiffPart[];
  const mdOf = (nodes: PMNode[]): string => (nodes.length === 0 ? "" : docToMarkdown(docNode(schema, nodes)));
  try {
    const baseBlocks = topBlocks(markdownToDoc(base, schema));
    const nextBlocks = topBlocks(markdownToDoc(next, schema));
    const segs = blockDiffSegments(baseBlocks, nextBlocks);
    parts = [];
    let bi = 0;
    let chainId = 0;
    for (let si = 0; si < segs.length; ) {
      const seg = segs[si]!;
      // A top-level segment is a plain block-range replacement.
      if (seg.path.length === 0) {
        for (; bi < seg.startBlock; bi++) parts.push({ kind: "eq", node: baseBlocks[bi]! });
        parts.push({ kind: "hunk", dels: baseBlocks.slice(seg.startBlock, seg.endBlock), ins: seg.replacement });
        bi = seg.endBlock;
        si++;
        continue;
      }
      // Nested segments within one top-level block: one hunk per segment, each
      // carrying that block's successive states.
      const top = seg.path[0]!;
      let sj = si;
      while (sj < segs.length && segs[sj]!.path.length > 0 && segs[sj]!.path[0] === top) sj++;
      const group = segs.slice(si, sj);
      for (; bi < top; bi++) parts.push({ kind: "eq", node: baseBlocks[bi]! });
      const id = ++chainId;
      // Each chained state rebuilds the container, so a wholesale rewrite stays one hunk.
      const chained = group.length > 1 && group.length <= MAX_NESTED_HUNKS;
      const states = chained ? group.map((_, g) => applyNestedSegments(baseBlocks[top]!, group.slice(0, g + 1))) : [applyNestedSegments(baseBlocks[top]!, group)];
      let prev = baseBlocks[top]!;
      for (const state of states) {
        parts.push({ kind: "hunk", dels: [prev], ins: [state], chain: chained ? id : undefined });
        prev = state;
      }
      bi = top + 1;
      si = sj;
    }
    for (; bi < baseBlocks.length; bi++) parts.push({ kind: "eq", node: baseBlocks[bi]! });
  } catch {
    return wholeDoc();
  }

  let attempt = buildEdits(base, parts, mdOf);
  while (typeof attempt === "number") {
    const failing = parts[attempt]!;
    if (failing.kind === "hunk" && failing.chain !== undefined) {
      parts = collapseChains(parts, failing.chain);
    } else if (parts.some((p) => p.kind === "hunk" && p.chain !== undefined)) {
      // Neighbour merging assumes disjoint hunks, which chains are not.
      parts = collapseChains(parts);
    } else {
      const merged = mergeHunkWithNeighbor(parts, attempt);
      if (!merged) return wholeDoc();
      parts = merged;
    }
    attempt = buildEdits(base, parts, mdOf);
  }
  if (applyStrEdits(base, attempt) !== next) return wholeDoc();
  return attempt;
}
