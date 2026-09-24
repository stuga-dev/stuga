/**
 * Deterministic synthesis of AI-citation footnotes.
 *
 * The co-author writes `[^n]` markers numbered per turn. Applying a turn:
 *  1. renumbers its markers past the document's existing footnotes;
 *  2. applies the surgical edits;
 *  3. merges synthesized definitions — `[^n]: [Title — Section](/doc/id) "excerpt"`
 *     — into a trailing block with no heading (the editor shows them in its
 *     Sources tab, so a heading would be a phantom outline entry);
 *  4. drops every definition no marker references any more.
 *
 * Steps 1–2 (`applyRenumberedStrEdits`) and 3–4 (`reconcileFootnotes`) are
 * separate because the run ledger stages only the body for review and
 * reconciles definitions once it knows which hunks landed.
 */
import { applyStrEdits, type StrEditOp } from "./diff/str-edits.js";
import { fencedLines } from "./markdown/fences.js";

/** A citation to materialize as a footnote. */
export interface CitationInput {
  /** The source's number as written in the edit text's `[^n]`. */
  n: number;
  doc_id: string;
  title: string;
  heading_path?: string | null;
  /** Frozen excerpt of the cited passage. */
  content?: string | null;
}

const FOOTNOTE_REF = /\[\^(\d+)\](?!:)/g; // a [^n] marker NOT starting a definition
const FOOTNOTE_DEF = /^\[\^(\d+)\]:\s?(.*)$/; // a "[^n]: …" definition line

/** Highest footnote number appearing anywhere in the markdown (0 if none). */
export function maxFootnoteNumber(markdown: string): number {
  let max = 0;
  for (const m of markdown.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Escape markdown link/bracket metacharacters + collapse whitespace to one line. */
function escInline(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/([[\]])/g, "\\$1");
}

/** The text after "[^n]: " for a synthesized definition: link + optional excerpt. */
function synthDef(c: CitationInput): string {
  const label = c.heading_path ? `${c.title || "Untitled"} — ${c.heading_path}` : c.title || "Untitled";
  const link = `[${escInline(label)}](/doc/${c.doc_id})`;
  const excerpt = escInline(c.content ?? "");
  return excerpt ? `${link} "${excerpt}"` : link;
}

/**
 * Map each distinct `[^n]` / `[n]` marker in `text` to a dense number starting at
 * `startAt`, in order of first appearance, so citations of raw search-result
 * positions (`[^2]`, `[^5]`) read as gapless footnotes.
 */
export function denseFootnoteMap(text: string, startAt = 1): Map<number, number> {
  const map = new Map<number, number>();
  let next = startAt;
  for (const m of text.matchAll(/\[\^?(\d+)\]/g)) {
    const old = Number(m[1]);
    if (!map.has(old)) map.set(old, next++);
  }
  return map;
}

/** Rewrite every `[^k]` marker in `text` via `map` (leaves definitions alone). */
function remapMarkers(text: string, map: Map<number, number>): string {
  return text.replace(FOOTNOTE_REF, (all, k: string) => {
    const to = map.get(Number(k));
    return to === undefined ? all : `[^${to}]`;
  });
}

/** Split markdown into its body and its definitions by number. A definition-shaped line inside fenced code is code, not a definition. */
function extractDefs(markdown: string): { body: string; defs: Map<number, string> } {
  const defs = new Map<number, string>();
  const kept: string[] = [];
  const lines = markdown.split("\n");
  const fenced = fencedLines(lines);
  lines.forEach((line, i) => {
    const m = fenced[i] ? null : FOOTNOTE_DEF.exec(line);
    if (m) defs.set(Number(m[1]), m[2] ?? "");
    else kept.push(line);
  });
  return { body: kept.join("\n"), defs };
}

/** True when neither the document nor this turn has any footnote to think about. */
function noFootnotesInPlay(markdown: string, citations: CitationInput[]): boolean {
  return citations.length === 0 && !/\[\^\d+\]/.test(markdown);
}

/**
 * Steps 1–2: renumber this turn's markers past the document's footnotes and
 * apply the edits, leaving the definitions block alone. Returns the old→new
 * marker map so the caller can find this turn's citations under their new numbers.
 */
export function applyRenumberedStrEdits(
  currentMarkdown: string,
  edits: StrEditOp[],
  citations: CitationInput[] = [],
): { markdown: string; renumber: Map<number, number> } {
  if (noFootnotesInPlay(currentMarkdown, citations)) {
    return { markdown: applyStrEdits(currentMarkdown, edits), renumber: new Map() };
  }
  const startAt = maxFootnoteNumber(currentMarkdown) + 1;
  const editText = edits.map((e) => e.new_string ?? "").join("\n");
  const renumber = denseFootnoteMap(editText, startAt);
  const remappedEdits = edits.map((e) => ({ old_string: e.old_string, new_string: remapMarkers(e.new_string, renumber) }));
  return { markdown: applyStrEdits(currentMarkdown, remappedEdits), renumber };
}

/**
 * Steps 3–4: synthesize a definition for every cited marker present in
 * `markdown` and drop every definition nothing references. Idempotent, so it is
 * safe on every commit of the same run.
 */
export function reconcileFootnotes(
  markdown: string,
  citations: CitationInput[] = [],
  renumber: Map<number, number> = new Map(),
): string {
  const { body, defs } = extractDefs(markdown);
  for (const c of citations) {
    const to = renumber.get(c.n);
    if (to !== undefined) defs.set(to, synthDef(c));
  }

  const referenced = new Set<number>();
  for (const m of body.matchAll(FOOTNOTE_REF)) referenced.add(Number(m[1]));
  const kept = [...defs.entries()].filter(([n]) => referenced.has(n)).sort((a, b) => a[0] - b[0]);

  // trimEnd, not /\s+$/, which is quadratic on a body ending in a non-space.
  const trimmed = body.trimEnd();
  if (kept.length === 0) return trimmed + "\n";
  const block = kept.map(([n, txt]) => `[^${n}]: ${txt}`).join("\n");
  return `${trimmed}\n\n${block}\n`;
}

/** All four steps at once, for apply paths with no review step. */
export function applyCitedStrEdits(
  currentMarkdown: string,
  edits: StrEditOp[],
  citations: CitationInput[] = [],
): string {
  // Judged on the input: with nothing to renumber there is nothing to reconcile,
  // which keeps a plain apply free of trailing-whitespace rewrites.
  const fresh = noFootnotesInPlay(currentMarkdown, citations);
  const { markdown, renumber } = applyRenumberedStrEdits(currentMarkdown, edits, citations);
  return fresh ? markdown : reconcileFootnotes(markdown, citations, renumber);
}
