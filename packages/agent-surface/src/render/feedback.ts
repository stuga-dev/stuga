/**
 * What a reviewer said when they rejected an agent's proposals, as the agent reads it back. The
 * reviewer's words are advice to revise from, never a rule: they decide nothing about what a later
 * write may do. Every quoted string is JSON-encoded, so a note or an excerpt stays on one line and
 * cannot close the block or pose as another.
 */
import { feedbackExcerpt, type AgentFeedback, type RunFeedback } from "@stuga/protocol/domain/runs";
import { RUN_FEEDBACK_MAX_CHANGES } from "@stuga/protocol/domain/limits";

export const FEEDBACK_OPEN = "=== CHANGES REQUESTED on your earlier proposals here (not part of any document) ===";
export const FEEDBACK_CLOSE = "=== END OF CHANGES REQUESTED ===";

/** Where the block rides: a document read or write, or a database's. */
export type FeedbackPlace = "document" | "database";

const NOT_UNCHANGED =
  "Do not resend a rejected change unchanged. A rejection without a note means the change was not wanted; if it is " +
  "unclear why, ask the user";

const FEEDBACK_ADVICE: Record<FeedbackPlace, string> = {
  document:
    "Revise from it: re-read the current text, then propose a new version of those passages only, one that answers " +
    `the note, and leave the rest of the document as it is. ${NOT_UNCHANGED} with a comment.`,
  database:
    "Revise from it: re-read the schema or the rows concerned, then propose those changes again only as the note asks, " +
    `and leave the rest of the database as it is. ${NOT_UNCHANGED}.`,
};

/** One piece of feedback as lines: what was rejected, then the note. */
function feedbackLines(fb: AgentFeedback): string[] {
  const lines = [`- ${fb.id} (run ${fb.run_id}): the reviewer rejected`];
  for (const c of fb.changes) {
    if (!("summary" in c)) lines.push(`    ${JSON.stringify(c.old_string)} → ${JSON.stringify(c.new_string)}`);
    else lines.push(c.detail ? `    ${JSON.stringify(c.summary)}: ${c.detail}` : `    ${JSON.stringify(c.summary)}`);
  }
  if (fb.more) lines.push(`    …and ${fb.more} more change(s) in the same decision`);
  lines.push(fb.note ? `  Their note: ${JSON.stringify(fb.note)}` : "  They left no note.");
  return lines;
}

/** The fenced block a read or a proposal carries; "" when there is nothing to say. */
export function renderFeedback(items: AgentFeedback[] | undefined, place: FeedbackPlace = "document"): string {
  if (!items?.length) return "";
  return [FEEDBACK_OPEN, ...items.flatMap(feedbackLines), FEEDBACK_ADVICE[place], FEEDBACK_CLOSE].join("\n");
}

/** A run's rejections grouped by the decision that made them, newest first, as `status` lists them. */
export function feedbackOfRun(
  runId: string,
  items: Array<{ status: string; feedback?: RunFeedback; change: AgentFeedback["changes"][number] }>,
): AgentFeedback[] {
  const byId = new Map<string, AgentFeedback>();
  for (const item of items) {
    const fb = item.status === "rejected" ? item.feedback : undefined;
    if (!fb) continue;
    let out = byId.get(fb.id);
    if (!out) {
      out = { id: fb.id, run_id: runId, ...(fb.note ? { note: fb.note } : {}), decided_at: fb.decided_at, changes: [] };
      byId.set(fb.id, out);
    }
    if (out.changes.length < RUN_FEEDBACK_MAX_CHANGES) out.changes.push(item.change);
    else out.more = (out.more ?? 0) + 1;
  }
  return [...byId.values()].sort((a, b) => b.decided_at - a.decided_at);
}

/** A document hunk as one side of a rejected change. */
export function hunkChange(h: { old_string: string; new_string: string }): AgentFeedback["changes"][number] {
  return { old_string: feedbackExcerpt(h.old_string), new_string: feedbackExcerpt(h.new_string) };
}

/** Status lines for a run's rejections: indented under the run's own line. */
export function statusFeedbackLines(items: AgentFeedback[]): string[] {
  return items.flatMap((fb) => feedbackLines(fb).map((line) => `  ${line}`));
}
