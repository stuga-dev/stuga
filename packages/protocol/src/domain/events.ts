/** The workspace event feed's vocabulary: what agents poll for and webhooks subscribe to. */
export const WORKSPACE_EVENT_TYPES = [
  /** A document or database row was created. */
  "doc.created",
  /** A document's content was flushed. */
  "doc.updated",
  /** A document was moved to the trash. */
  "doc.trashed",
  /** An agent parked hunks (or ops) for review. */
  "run.proposed",
  /** An agent's edits landed without a human decision (an `auto` document). */
  "run.applied",
  /** A human accepted or rejected part or all of a run. */
  "run.decided",
  /** A human reverted a landed run. */
  "run.reverted",
  /** A comment was added to a document. */
  "comment.added",
  /** A database's rows or schema changed. */
  "database.changed",
] as const;

export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number];

export function isWorkspaceEventType(v: unknown): v is WorkspaceEventType {
  return typeof v === "string" && (WORKSPACE_EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * How an agent's proposal is decided: by the document's (or database's) own
 * `agent_mode`, never by whether a reviewer happens to be watching.
 */
export type ReviewMode = "review" | "auto";

const REVIEW_MODES: readonly ReviewMode[] = ["review", "auto"];

export function isReviewMode(v: unknown): v is ReviewMode {
  return typeof v === "string" && (REVIEW_MODES as readonly string[]).includes(v);
}

const REVIEW_RANK: Record<ReviewMode, number> = { auto: 0, review: 1 };

/** A run holding `review` hunks must not auto-apply them because a later proposal arrived under `auto`. */
export function stricterReviewMode(a: ReviewMode, b: ReviewMode): ReviewMode {
  return REVIEW_RANK[a] >= REVIEW_RANK[b] ? a : b;
}
