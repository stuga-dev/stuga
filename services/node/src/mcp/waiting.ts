/**
 * Waiting AI changes as they would land: what a run's pending hunks change in the approved text, taken
 * together. A run's hunks apply in turn to the text with its earlier ones laid over, so a later hunk may
 * edit text an earlier one wrote; told one by one, that edit reads as a change to approved text. Diffing
 * the approved text against the run's projection tells each change once, against what is approved now.
 */
import { headingPathAt } from "@stuga/ai";
import { applyStrEditsStrict, computeStrEdits } from "@stuga/crdt-ops";
import type { WaitsFor } from "@stuga/agent-surface/backend";
import { sharedWords } from "@stuga/db";
import { stricterReviewMode, type ReviewMode } from "@stuga/protocol/domain/events";

/**
 * Who approves a change proposed at `proposed` to an item at `itemNow`: a decision takes the stricter of the
 * two. A change at `auto` waits only behind earlier ones, which the person who asked decides first.
 */
export function waitsFor(proposed: ReviewMode, itemNow: ReviewMode): WaitsFor {
  return stricterReviewMode(proposed, itemNow) === "colleague" ? "colleague" : "review";
}

export interface NetChange {
  /** The approved lines it changes, whole, the lines it keeps left out: "" when it adds. */
  approvedNow: string;
  /** What those lines read once it is approved: "" when it removes them. */
  afterApproval: string;
  /** For an addition, the approved line it follows, or, when it goes first, the one it precedes: neither on an empty page. */
  addsAfter?: string;
  addsBefore?: string;
  /** The heading path of the section it lands in, as a passage names its own ("Globex > Contract"): "" before any heading. */
  section: string;
}

export interface NetOfRun {
  changes: NetChange[];
  /** Pending hunks that no longer lay over the approved text (it changed under them): counted, never told. */
  unread: number;
}

/** The changes a run's pending `hunks` make to `approved`, taken together, in the order of the text. */
export function netChanges(approved: string, hunks: ReadonlyArray<{ old_string: string; new_string: string }>): NetOfRun {
  if (hunks.length === 0) return { changes: [], unread: 0 };
  const laid = applyStrEditsStrict(
    approved,
    hunks.map((h) => ({ old_string: h.old_string, new_string: h.new_string })),
  );
  const unread = laid.conflicts.length;
  if (laid.markdown === approved) return { changes: [], unread };
  const changes: NetChange[] = [];
  for (const hunk of computeStrEdits(approved, laid.markdown)) {
    const at = hunk.old_string === "" ? approved.length : Math.max(0, approved.indexOf(hunk.old_string));
    const a = hunk.old_string.split("\n");
    const b = hunk.new_string.split("\n");
    // The lines both sides share, at either end, are where it is, not what it changes.
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const approvedNow = a.slice(head, a.length - tail).join("\n").trim();
    const afterApproval = b.slice(head, b.length - tail).join("\n").trim();
    if (approvedNow === afterApproval) continue;
    const start = at + a.slice(0, head).reduce((n, line) => n + line.length + 1, 0);
    const change: NetChange = {
      approvedNow,
      afterApproval,
      // An addition lands where the text before it is; a change, where the text it changes starts.
      section: headingPathAt(approved, approvedNow === "" ? start - 1 : start),
    };
    if (approvedNow === "") {
      const after = a.slice(0, head).filter((line) => line.trim() !== "").at(-1);
      const before = a.slice(a.length - tail).find((line) => line.trim() !== "");
      if (after !== undefined) change.addsAfter = after.trim();
      else if (before !== undefined) change.addsBefore = before.trim();
    }
    changes.push(change);
  }
  return { changes, unread };
}

/** How many of a question's words a change holds, on either side: the ones about the question are listed first. */
export function relevance(query: string, change: Pick<NetChange, "approvedNow" | "afterApproval">): number {
  if (query.trim() === "") return 0;
  return sharedWords(query, `${change.approvedNow}\n${change.afterApproval}`, 50).length;
}

/** A passage a change may be listed on. */
export interface PassageOf {
  content: string;
  heading_path: string | null;
}

/**
 * Which of a document's passages a change lands in: the one holding the approved text it changes, else one of
 * the section it lands in, the one holding the line an addition follows first. -1 when none was returned.
 */
export function landsIn(change: NetChange, passages: readonly PassageOf[]): number {
  if (change.approvedNow !== "") {
    const holder = passages.findIndex((p) => p.content.includes(change.approvedNow));
    if (holder >= 0) return holder;
  }
  const section = passages.flatMap((p, i) => ((p.heading_path ?? "") === change.section ? [i] : []));
  const anchor = change.addsAfter ?? change.addsBefore;
  const anchored = anchor === undefined ? -1 : section.find((i) => passages[i]!.content.includes(anchor)) ?? -1;
  return anchored >= 0 ? anchored : (section[0] ?? -1);
}
