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
  /** A human undid a decision: some of a run's changes wait for review again. */
  "run.reopened",
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
 * How an agent's proposal is decided: by the level the document (or database) is at, its own
 * `agent_mode` or else its folder's, never by whether a reviewer happens to be watching. `auto`
 * applies at once; `review` waits for whoever asked the AI; `colleague` waits for someone else who
 * can edit it, an administrator included, never the one who asked.
 */
export type ReviewMode = "auto" | "review" | "colleague";

/** Loosest first. */
export const REVIEW_MODES: readonly ReviewMode[] = ["auto", "review", "colleague"];

export function isReviewMode(v: unknown): v is ReviewMode {
  return typeof v === "string" && (REVIEW_MODES as readonly string[]).includes(v);
}

const REVIEW_RANK: Record<ReviewMode, number> = { auto: 0, review: 1, colleague: 2 };

/**
 * The stricter of two levels. A run holding `review` hunks must not auto-apply them because a later
 * proposal arrived under `auto`, and a decision takes the stricter of the level a run was proposed
 * under and the one its item is at now, so neither a move nor a later loosening releases it.
 */
export function stricterReviewMode(a: ReviewMode, b: ReviewMode): ReviewMode {
  return REVIEW_RANK[a] >= REVIEW_RANK[b] ? a : b;
}

/** An item's level: its own, else the one its folders give it, else `review`. */
export function reviewLevelOf(own: ReviewMode | null, inherited: ReviewMode | null): ReviewMode {
  return own ?? inherited ?? "review";
}

/**
 * A document's or database's level now: its own, else the one its folders give it, else `review`;
 * a row page's at least its database's, so a page is never reviewed more loosely than its table.
 */
export function docReviewLevel(doc: {
  agent_mode: ReviewMode | null;
  folder_agent_mode: ReviewMode | null;
  database_agent_mode?: ReviewMode | null;
}): ReviewMode {
  const own = reviewLevelOf(doc.agent_mode, doc.folder_agent_mode);
  return doc.database_agent_mode ? stricterReviewMode(own, doc.database_agent_mode) : own;
}

/** Whether `a` lets more through than `b`. */
export function looserReviewMode(a: ReviewMode, b: ReviewMode): boolean {
  return REVIEW_RANK[a] < REVIEW_RANK[b];
}
