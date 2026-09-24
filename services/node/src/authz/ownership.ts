import { getMemberRole, type Sql } from "@stuga/db";
import { agentPrincipal, userPrincipal, type OwnGrants } from "@stuga/auth";

/**
 * Who owns a newly created document or folder. An agent creates for the human
 * who minted its key and stays a co-writer; that human's membership is
 * re-checked, since a key outlives offboarding and ownership is what `manages()` tests.
 */
export interface DocOwnership {
  /** The key's human, or the agent itself when that human may not own content here. */
  owner: string;
  /** The agent as a direct grant, so re-flattening from own_grants keeps it. */
  ownGrants: OwnGrants;
}

export type OwnershipCtx = { alias: string; sql: Sql; workspaceId: string } & (
  | { isAgent: false }
  | { isAgent: true; onBehalfOf: string }
);

export async function docOwnership(ctx: OwnershipCtx): Promise<DocOwnership> {
  if (!ctx.isAgent) return { owner: userPrincipal(ctx.alias), ownGrants: { p: [], w: [], c: [] } };
  const agent = agentPrincipal(ctx.alias);
  const role = await getMemberRole(ctx.sql, ctx.workspaceId, ctx.onBehalfOf);
  // A guest may not create content, and an ex-member owns nothing new.
  const owner = role && role !== "guest" ? userPrincipal(ctx.onBehalfOf) : agent;
  return { owner, ownGrants: { p: [agent], w: [agent], c: [] } };
}
