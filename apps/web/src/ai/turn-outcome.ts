/**
 * What became of one co-author turn's changes, read from its run as the ledger holds it now, so the
 * chat says what the document shows rather than what the turn reported when it ended.
 */
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";

export type TurnOutcome =
  | { kind: "pending"; count: number }
  | { kind: "applied"; count: number }
  | { kind: "accepted" }
  | { kind: "rejected" }
  | { kind: "replaced" }
  | { kind: "reverted" }
  | { kind: "mixed"; accepted: number; rejected: number };

/**
 * Null when the run or its changes are not at hand (an older run, or one sent without its changes).
 * `revised` holds the rejections a later turn of this chat was asked to revise.
 */
export function turnOutcome(
  run: AgentRunSummary | undefined,
  hunkIds: readonly string[] | undefined,
  revised: ReadonlySet<string> = new Set(),
): TurnOutcome | null {
  if (!run || !hunkIds?.length || run.hunks_truncated) return null;
  const ids = new Set(hunkIds);
  const mine = run.hunks.filter((h) => ids.has(h.id));
  if (mine.length === 0) return null;
  const pending = mine.filter((h) => h.status === "pending").length;
  if (pending > 0) return { kind: "pending", count: pending };
  if (run.reverted) return { kind: "reverted" };
  // A change that could not apply was neither accepted nor rejected by anyone; with only those, the turn's own footer stands.
  const decided = mine.filter((h) => h.status !== "conflict");
  if (decided.length === 0) return null;
  const autoApplied = decided.filter((h) => h.status === "auto_applied").length;
  if (autoApplied === decided.length) return { kind: "applied", count: autoApplied };
  const accepted = decided.filter((h) => h.status === "accepted" || h.status === "auto_applied").length;
  const rejected = decided.length - accepted;
  if (rejected === 0) return { kind: "accepted" };
  if (accepted > 0) return { kind: "mixed", accepted, rejected };
  // Rejected with a note the co-author has since answered: a newer suggestion stands in for it.
  const answered = mine.some((h) => h.feedback && (revised.has(h.feedback.id) || (h.feedback.note && h.feedback.addressed_at !== undefined)));
  return answered ? { kind: "replaced" } : { kind: "rejected" };
}
