/** A document's comments as a caller reads them. */
import { agentOwners, type CommentRow, type Sql } from "@stuga/db";
import { SAMPLE_AGENT_ALIAS } from "@stuga/protocol/domain/workspaces";
import type { Ctx } from "../auth/context.js";

/** An agent's own comments marked `you: true`, so it can tell its words from others'; a person's read is as stored. */
export function markYours(ctx: Ctx, rows: CommentRow[]): Array<CommentRow & { you?: true }> {
  if (!ctx.isAgent) return rows;
  return rows.map((c) => (c.author === ctx.alias ? { ...c, you: true as const } : c));
}

/**
 * The person each agent among the comments' authors acts for, from its key or grant, or null when
 * that is gone: how a page names an agent, never by the name its client chose. The sample agent
 * acts for no one.
 */
export async function commentAgents(sql: Sql, rows: readonly CommentRow[]): Promise<Record<string, string | null>> {
  const ids = [...new Set(rows.map((c) => c.author).filter((a) => a.startsWith("agent-") && a !== SAMPLE_AGENT_ALIAS))];
  if (ids.length === 0) return {};
  const owners = await agentOwners(sql, ids);
  return Object.fromEntries(ids.map((id) => [id, owners.get(id) ?? null]));
}
