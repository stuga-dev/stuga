/**
 * Whether an agent's proposal parks for a person or applies at once, read from
 * the document's `agent_mode`. A human session always gets `review`: `auto` is
 * for background connectors, not a turn someone is sitting in front of.
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
  return doc.agent_mode === "auto"
    ? { mode: "auto", reason: "this document is set to apply agent changes at once" }
    : { mode: "review", reason: "this document waits for review" };
}
