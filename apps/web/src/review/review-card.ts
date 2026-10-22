/**
 * The review card's reading of one run: each change in the paragraph it sits in, under the section
 * it is in, with the sources its footnote markers cite; and, for whoever cannot approve it, why.
 * Presentation only: what a decision commits is the actor's own apply.
 */
import type { CitationInput } from "@stuga/crdt-ops";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { RunStanding } from "@stuga/protocol/domain/runs";
import { findFuzzyMatch } from "@stuga/protocol/text/fuzzy-match";
import type { AgentRunHunk } from "@stuga/protocol/wire/doc-socket";

/** One source a change cites, as the card lists it under the change. */
export interface CardSource {
  n: number;
  title: string;
  /** The document it links to, when it is one in Stuga. */
  docId: string | null;
  excerpt: string | null;
}

/** One change as the card shows it. */
export interface CardChange {
  hunk: AgentRunHunk;
  /** The blocks the change sits in, as they read before it and after it; the change alone when its place is not found. */
  before: string;
  after: string;
  /** The nearest heading above it; null above the first heading, or when its place is not found. */
  section: string | null;
  /** What its new text cites, in the order it cites them. */
  sources: CardSource[];
}

const DEFINITION = /^\[\^(\d+)\]:[ \t]?(.*)$/gm;
const MARKER = /\[\^(\d+)\](?!:)/g;
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t#]*$/gm;
/** A definition the node writes for a cited source: `[Title — heading](/doc/<id>) "excerpt"`. */
const SYNTH_DEFINITION = /^\[((?:\\.|[^\]\\])*)\]\(\/doc\/([^)\s]+)\)(?:\s+"(.*)")?$/;

/** The footnote definitions written in `markdown`, by number. */
export function footnoteDefinitions(markdown: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of markdown.matchAll(DEFINITION)) out.set(Number(m[1]), m[2]!.trim());
  return out;
}

/** `markdown` without its footnote definitions, which the card lists as sources instead. */
export function withoutDefinitions(markdown: string): string {
  return markdown.replace(DEFINITION, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The footnote numbers `markdown` cites, each once, in order. */
export function citedNumbers(markdown: string): number[] {
  return [...new Set([...markdown.matchAll(MARKER)].map((m) => Number(m[1])))];
}

/** The heading nearest above `at`, as plain text. */
function sectionAt(markdown: string, at: number): string | null {
  let found: string | null = null;
  for (const m of markdown.slice(0, at).matchAll(HEADING)) found = m[1]!.replace(/[*_`~]/g, "").trim();
  return found || null;
}

/** A definition as a source: the node's own link to a document, or the text as written. */
function sourceOf(n: number, citation: CitationInput | undefined, definition: string | undefined): CardSource | null {
  if (citation) {
    const title = citation.heading_path ? `${citation.title} — ${citation.heading_path}` : citation.title;
    return { n, title, docId: citation.doc_id, excerpt: citation.content?.trim() || null };
  }
  if (definition === undefined) return null;
  const m = SYNTH_DEFINITION.exec(definition);
  if (!m) return { n, title: definition, docId: null, excerpt: null };
  let docId: string | null;
  try {
    docId = decodeURIComponent(m[2]!);
  } catch {
    docId = null;
  }
  return { n, title: m[1]!.replace(/\\(.)/g, "$1"), docId, excerpt: m[3] ?? null };
}

/**
 * Every change of a run, in order, each read against the document as the run built it up: the
 * baseline with the changes before it applied, as the agent proposed them. Without a baseline (the
 * reader sees only what landed) each change stands alone.
 */
export function cardChanges(baseline: string | null, hunks: readonly AgentRunHunk[], citations: readonly CitationInput[] = []): CardChange[] {
  const definitions = footnoteDefinitions(baseline ?? "");
  for (const h of hunks) for (const [n, text] of footnoteDefinitions(h.new_string)) definitions.set(n, text);
  const cited = new Map(citations.map((c) => [c.n, c]));
  let working = baseline;
  return hunks.map((hunk) => {
    let before = hunk.old_string;
    let after = hunk.new_string;
    let section: string | null = null;
    if (working !== null) {
      const match = hunk.old_string === "" ? { index: working.length, matched: "" } : findFuzzyMatch(working, hunk.old_string);
      if (match) {
        const end = match.index + match.matched.length;
        const blockStart = working.lastIndexOf("\n\n", match.index - 1);
        const start = hunk.old_string === "" ? end : blockStart < 0 ? 0 : blockStart + 2;
        const blockEnd = working.indexOf("\n\n", end);
        const stop = blockEnd < 0 ? working.length : blockEnd;
        before = working.slice(start, stop);
        after = working.slice(start, match.index) + hunk.new_string + working.slice(end, stop);
        section = sectionAt(working, start);
        working = working.slice(0, match.index) + hunk.new_string + working.slice(end);
      }
    }
    const sources = citedNumbers(hunk.new_string)
      .map((n) => sourceOf(n, cited.get(n), definitions.get(n)))
      .filter((s): s is CardSource => s !== null);
    return { hunk, before: withoutDefinitions(before), after: withoutDefinitions(after), section, sources };
  });
}

/** Why the reader may not approve a run they see waiting, for the line beside Approve; null when they may. */
export type ApproveBlock =
  | { kind: "own"; waitsFor: "colleague" | "nobody" | "group" }
  | { kind: "colleague"; group: string | null }
  | { kind: "reviewer" }
  | { kind: "locked" };

/**
 * Why Approve is off for this reader, said beside it, never only in a tooltip. Nothing when they
 * may approve, or when nothing waits. A locked item refuses any approval, so it comes first for
 * someone who could otherwise; whoever asked at `colleague` is told whom it waits for; anyone else
 * which level decides it.
 */
export function approveBlock(input: {
  you: RunStanding | undefined;
  me: string | null;
  reviewer: string;
  level: ReviewMode;
  approverGroup: string | null;
  locked: boolean;
  pending: number;
}): ApproveBlock | null {
  const { you, me, reviewer, level, pending } = input;
  if (pending === 0 || !you) return null;
  if (you.accept) return input.locked ? { kind: "locked" } : null;
  if (level === "colleague" && me === reviewer) return { kind: "own", waitsFor: you.waits_for ?? "colleague" };
  if (level === "colleague") return { kind: "colleague", group: input.approverGroup };
  return { kind: "reviewer" };
}
