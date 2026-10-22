/** The workspace's review inbox and per-agent statistics, for humans. */
import { type AgentRunRow, type RunInboxFilter, agentNames, agentRunStats, approversFor, listAgentRuns } from "@stuga/db";
import { stricterReviewMode } from "@stuga/protocol/domain/events";
import { actLevel, mayActOnRun, type RunAct, type RunStanding } from "@stuga/protocol/domain/runs";
import { instant } from "../audit/read.js";
import type { Ctx } from "../auth/context.js";
import { isWorkspaceAdmin, manages } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/**
 * Rows the inbox returns: the mirror row plus the agent's display name, where the caller stands on
 * it (`you`), as on a document's own runs (RunJudge), and whether they may decide the run at all
 * (`can_decide`: accept or reject it, with write access to the document as the decision routes ask),
 * so others see it read-only. Who else may approve is looked up for the whole page in one query.
 */
async function withAgentNames(ctx: Ctx, runs: AgentRunRow[]) {
  const names = await agentNames(ctx.sql, [...new Set(runs.map((r) => r.agent_alias))]);
  const groupsOf = (r: AgentRunRow) => [...new Set([r.approver_group, r.doc_approver_group].filter((g): g is string => !!g))];
  const inGroups = (groups: string[]) => groups.every((g) => ctx.principals.includes(g));
  const managerOf = (r: AgentRunRow) => manages(ctx, { owner: r.doc_owner });
  const writerOf = (r: AgentRunRow) => !ctx.isAgent && r.doc_writable;
  // Who else may approve matters to the run's reviewer (whom it waits for) and to a manager outside
  // its groups (who stands in only while nobody else can).
  const keyOf = (r: AgentRunRow) => JSON.stringify([r.doc_id, r.reviewer, groupsOf(r)]);
  const needs = runs.filter(
    (r) =>
      stricterReviewMode(r.review_mode, r.doc_level) === "colleague" &&
      (ctx.alias === r.reviewer || (writerOf(r) && managerOf(r) && !inGroups(groupsOf(r)))),
  );
  const found = await approversFor(
    ctx.sql,
    ctx.workspaceId,
    needs.map((r) => ({
      key: keyOf(r),
      item: { acl_principals: r.doc_readers, acl_writers: r.doc_writers, owner: r.doc_owner },
      reviewer: r.reviewer,
      groups: groupsOf(r),
    })),
  );
  return runs.map((r) => {
    const level = stricterReviewMode(r.review_mode, r.doc_level);
    const manager = managerOf(r);
    const writer = writerOf(r);
    let approver = false;
    let waitsFor: RunStanding["waits_for"];
    if (level === "colleague") {
      const approvers = found.get(keyOf(r));
      if (ctx.alias !== r.reviewer && writer) approver = inGroups(groupsOf(r)) || (manager && approvers?.standIn === true);
      if (ctx.alias === r.reviewer) waitsFor = approvers && approvers.aliases.length === 0 ? (approvers.cause ?? "nobody") : "colleague";
    }
    const may = (act: RunAct) =>
      mayActOnRun({ act, level: actLevel(act, r.review_mode, r.doc_level), by: ctx.alias, reviewer: r.reviewer, approver, manager });
    const you: RunStanding = {
      level,
      accept: writer && may("accept"),
      reject: writer && may("reject"),
      ack: !ctx.isAgent && may("ack"),
      ...(waitsFor ? { waits_for: waitsFor } : {}),
    };
    // The document's ACL, owner and levels stay on the node.
    const { doc_owner: _owner, doc_writable: _writable, doc_readers: _readers, doc_writers: _writers, doc_level: _level, doc_approver_group: _group, ...row } = r;
    return { ...row, agent_name: names.get(r.agent_alias) ?? r.agent, you, can_decide: you.accept || you.reject };
  });
}

export async function listRunInbox({ ctx, url }: WorkspaceCall): Promise<Response> {
  const p = url.searchParams;
  const filterRaw = p.get("filter") ?? "attention";
  const filter: RunInboxFilter =
    filterRaw === "waiting" || filterRaw === "done" || filterRaw === "all" ? filterRaw : "attention";
  const limitRaw = Number(p.get("limit") ?? "");
  const beforeId = p.get("before_id");
  const beforeAt = instant("before_at", p.get("before_at"));
  if (!beforeAt.ok) return error(400, beforeAt.message);
  if (Boolean(beforeAt.value) !== Boolean(beforeId)) return error(400, "before_at and before_id go together");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
  const list = (f: RunInboxFilter) =>
    listAgentRuns(ctx.sql, {
      workspaceId: ctx.workspaceId,
      principals: ctx.principals,
      filter: f,
      agentAlias: p.get("agent") ?? undefined,
      before: beforeAt.value && beforeId ? { updatedAt: beforeAt.value, runId: beforeId } : undefined,
      limit,
      decider: { alias: ctx.alias, admin: isWorkspaceAdmin(ctx) },
    });
  if (filter !== "attention" && filter !== "waiting") return json({ runs: await withAgentNames(ctx, await list(filter)), filter });
  // The query counts an owner or admin outside a run's approver groups among those who may approve
  // it; they stand in only while nobody else may, which withAgentNames works out. Such a run waits on others.
  const needs = await withAgentNames(ctx, await list("attention"));
  if (filter === "attention") return json({ runs: needs.filter(asksCaller), filter });
  const others = [...(await withAgentNames(ctx, await list("waiting"))), ...needs.filter((r) => !asksCaller(r) && waits(r))];
  const at = (r: InboxRow) => new Date(r.updated_at).getTime();
  others.sort((a, b) => at(b) - at(a) || b.run_id.localeCompare(a.run_id));
  return json({ runs: others.slice(0, limit ?? others.length), filter });
}

type InboxRow = Awaited<ReturnType<typeof withAgentNames>>[number];

const waits = (r: InboxRow) => r.status === "open" && r.pending > 0;

/** What Needs you holds: changes waiting that the caller may accept, or applied at once that the caller may mark reviewed. */
function asksCaller(r: InboxRow): boolean {
  return (waits(r) && r.you.accept) || (r.auto_applied && !r.acknowledged && !r.reverted && r.you.ack);
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
