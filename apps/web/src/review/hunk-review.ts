/** One-line summaries of run hunks for the change list, as plain text. */
import type { AgentRunHunk } from "@stuga/protocol/wire/doc-socket";
import type { HunkKey } from "../editor/run-preview/plan";

type HunkKind = "add" | "remove" | "change";

interface HunkSummary {
  kind: HunkKind;
  /** Single-glyph marker for the row: `+` added, `−` removed, `~` reworded. */
  marker: "+" | "−" | "~";
  /** Short, whitespace-collapsed description of the changed span. */
  text: string;
  /** Fuller "before → after" for the row's tooltip. */
  detail: string;
}

/** How much of the changed span a row shows before it is elided. */
const SUMMARY_MAX = 60;


function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max = SUMMARY_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Strip the context both sides share. A boundary that lands mid-word snaps back
 * to the word's edge ("lazy"→"sleepy" reads "sleepy", not "sleep"); one already
 * at a space stays, so a pure insertion is not widened into a change.
 */
function changedSpan(before: string, after: string): { before: string; after: string } {
  const isSpace = (c: string | undefined) => c === undefined || c === " ";
  const max = Math.min(before.length, after.length);

  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  // lastIndexOf returning -1 gives 0: with no space, the whole fragment is kept.
  if (start > 0 && !isSpace(before[start - 1]) && (!isSpace(before[start]) || !isSpace(after[start]))) {
    start = before.lastIndexOf(" ", start) + 1;
  }

  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const tail = before.slice(before.length - end);
  if (end > 0 && !isSpace(tail[0]) && (!isSpace(before[before.length - end - 1]) || !isSpace(after[after.length - end - 1]))) {
    const spaceAt = tail.indexOf(" ");
    end = spaceAt >= 0 ? end - spaceAt : 0;
  }

  return {
    before: before.slice(start, before.length - end).trim(),
    after: after.slice(start, after.length - end).trim(),
  };
}

export function summarizeHunk(hunk: { old_string: string; new_string: string }): HunkSummary {
  const span = changedSpan(collapse(hunk.old_string), collapse(hunk.new_string));
  if (span.before && !span.after) {
    return { kind: "remove", marker: "−", text: clip(span.before), detail: `Removes: ${clip(span.before, 200)}` };
  }
  if (span.after && !span.before) {
    return { kind: "add", marker: "+", text: clip(span.after), detail: `Adds: ${clip(span.after, 200)}` };
  }
  // A reword, or a whitespace-only edit where the full pair is the description.
  const after = span.after || collapse(hunk.new_string);
  const before = span.before || collapse(hunk.old_string);
  return {
    kind: "change",
    marker: "~",
    text: clip(after || before),
    detail: `${clip(before, 200)} → ${clip(after, 200)}`,
  };
}

interface ReviewRow {
  hunk: AgentRunHunk;
  key: HunkKey;
  /** No ghost exists in the document for this hunk. */
  isAnchored: boolean;
}

/**
 * Painted hunks first in the overlay's document order, then the rest. A hunk the
 * overlay has not classified yet falls in with the unanchored ones, never dropped.
 */
export function orderRowsForReview(
  hunks: AgentRunHunk[],
  keyOf: (hunk: AgentRunHunk) => HunkKey,
  anchored: readonly HunkKey[],
): ReviewRow[] {
  const rows = hunks.map((hunk) => ({ hunk, key: keyOf(hunk), isAnchored: false }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const ordered: ReviewRow[] = [];
  for (const key of anchored) {
    const row = byKey.get(key);
    if (!row || ordered.includes(row)) continue;
    row.isAnchored = true;
    ordered.push(row);
  }
  for (const row of rows) if (!row.isAnchored) ordered.push(row);
  return ordered;
}
