/**
 * Whether an agent's proposal parks for a person or applies at once, read from
 * the document's `agent_mode`. A person's own proposal always gets `review`: it
 * is a suggestion, and the setting is about agents.
 */
import type { DocRow } from "@stuga/db";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { Ctx } from "../auth/context.js";

export interface ResolvedReview {
  mode: ReviewMode;
  /** Where the answer came from, in words an agent can read back. */
  reason: string;
}

/** Resolve the review mode for one proposal. */
export function resolveReviewMode(ctx: Ctx, doc: DocRow): ResolvedReview {
  if (!ctx.isAgent) return { mode: "review", reason: "a human session" };
  return agentReviewMode(doc);
}

/** The document's setting for any agent, the in-app co-author included. */
export function agentReviewMode(doc: Pick<DocRow, "agent_mode">): ResolvedReview {
  return doc.agent_mode === "auto"
    ? { mode: "auto", reason: "this document is set to let AI edits apply directly" }
    : { mode: "review", reason: "this document waits for review" };
}
