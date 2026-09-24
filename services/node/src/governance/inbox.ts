/** The workspace's review inbox and per-agent statistics, for humans. */
import { type AgentRunRow, type RunInboxFilter, agentNames, agentRunStats, listAgentRuns } from "@stuga/db";
import { instant } from "../audit/read.js";
import type { Ctx } from "../auth/context.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/** Rows the inbox returns: the mirror row plus the agent's display name. */
async function withAgentNames(ctx: Ctx, runs: AgentRunRow[]) {
  const names = await agentNames(ctx.sql, [...new Set(runs.map((r) => r.agent_alias))]);
  return runs.map((r) => ({ ...r, agent_name: names.get(r.agent_alias) ?? r.agent }));
}

export async function listRunInbox({ ctx, url }: WorkspaceCall): Promise<Response> {
  const p = url.searchParams;
  const filterRaw = p.get("filter") ?? "attention";
  const filter: RunInboxFilter =
    filterRaw === "open" || filterRaw === "closed" || filterRaw === "all" ? filterRaw : "attention";
  const limitRaw = Number(p.get("limit") ?? "");
  const beforeId = p.get("before_id");
  const beforeAt = instant("before_at", p.get("before_at"));
  if (!beforeAt.ok) return error(400, beforeAt.message);
  if (Boolean(beforeAt.value) !== Boolean(beforeId)) return error(400, "before_at and before_id go together");
  const runs = await listAgentRuns(ctx.sql, {
    workspaceId: ctx.workspaceId,
    principals: ctx.principals,
    filter,
    agentAlias: p.get("agent") ?? undefined,
    before: beforeAt.value && beforeId ? { updatedAt: beforeAt.value, runId: beforeId } : undefined,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined,
  });
  return json({ runs: await withAgentNames(ctx, runs), filter });
}

export async function agentStats({ ctx }: WorkspaceCall): Promise<Response> {
  const stats = await agentRunStats(ctx.sql, ctx.workspaceId, ctx.principals);
  const names = await agentNames(ctx.sql, stats.map((s) => s.agent_alias));
  return json(
    {
      agents: stats.map((s) => {
        const decided = s.accepted + s.rejected;
        return {
          ...s,
          agent_name: names.get(s.agent_alias) ?? s.agent,
          // Null until something was decided.
          acceptance_rate: decided > 0 ? s.accepted / decided : null,
        };
      }),
    },
  );
}
