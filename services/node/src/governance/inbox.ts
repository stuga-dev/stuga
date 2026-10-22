/** The workspace's review inbox and per-agent statistics, for humans. */
import { type AgentRunRow, type RunInboxFilter, agentNames, agentRunStats, approversFor, getChanges, listAgentRuns } from "@stuga/db";
import { stricterReviewMode, type ReviewMode } from "@stuga/protocol/domain/events";
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
    const queued = !!r.queued_behind && r.status === "open" && r.pending > 0;
    const you: RunStanding = {
      level,
      // A run queued behind the agent's earlier changes is accepted once those are decided.
      accept: writer && may("accept") && !queued,
      reject: writer && may("reject"),
      ack: !ctx.isAgent && may("ack"),
      ...(waitsFor ? { waits_for: waitsFor } : {}),
      ...(queued && writer && may("accept") ? { queued: true as const } : {}),
    };
    // The document's ACL, owner and levels stay on the node.
    const { doc_owner: _owner, doc_writable: _writable, doc_readers: _readers, doc_writers: _writers, doc_level: _level, doc_approver_group: _group, ...row } = r;
    return { ...row, agent_name: names.get(r.agent_alias) ?? r.agent, you, can_decide: you.accept || you.reject };
  });
}

/** Where a set of runs stands for the caller, as the tabs split them: one change goes under one tab. */
function tabOf(runs: readonly InboxRow[]): "attention" | "waiting" | "done" {
  if (runs.some(asksCaller)) return "attention";
  if (runs.some(waits)) return "waiting";
  return "done";
}

/**
 * A change as the inbox lists it: one row for all its runs the caller can see. Its title is the agent's
 * words about waiting text, so it goes only to someone who decides one of its runs or asked for it.
 */
function changeRow(changeId: string, runs: InboxRow[], change: { title: string; agent: string; agent_alias: string } | undefined, me: string) {
  const sum = (k: "pending" | "accepted" | "rejected" | "conflicts" | "applied") => runs.reduce((n, r) => n + r[k], 0);
  const waiting = runs.filter(waits);
  const level = waiting.reduce<ReviewMode | null>((m, r) => (m ? stricterReviewMode(m, r.you.level) : r.you.level), null);
  const sees = runs.some((r) => r.reviewer === me || r.you.accept || r.you.reject || r.you.queued === true);
  const first = runs[0]!;
  const docs = [...new Map(runs.map((r) => [r.doc_id, r.doc_title])).entries()];
  const at = (r: InboxRow) => new Date(r.updated_at).getTime();
  const latest = runs.reduce((a, b) => (at(b) > at(a) ? b : a));
  return {
    change_id: changeId,
    title: sees ? (change?.title ?? null) : null,
    agent: first.agent,
    agent_alias: first.agent_alias,
    agent_name: first.agent_name,
    source: first.source,
    client: first.client,
    model: first.model,
    reviewer: first.reviewer,
    run_ids: runs.map((r) => r.run_id),
    pages: docs.length,
    page_titles: docs.map(([, title]) => title),
    pending: sum("pending"),
    // Of those, the ones the caller may approve now.
    pending_yours: waiting.filter((r) => r.you.accept).reduce((n, r) => n + r.pending, 0),
    accepted: sum("accepted"),
    rejected: sum("rejected"),
    conflicts: sum("conflicts"),
    applied: sum("applied"),
    level: level ?? first.you.level,
    // What the caller may do with it: accept or reject a run of it now, or only once the runs ahead are decided.
    you: {
      accept: waiting.some((r) => r.you.accept),
      reject: waiting.some((r) => r.you.reject),
      ...(waiting.some((r) => r.you.queued) ? { queued: true as const } : {}),
      ...(waiting.length > 0 && waiting.every((r) => r.you.waits_for) ? { waits_for: waiting[0]!.you.waits_for } : {}),
    },
    can_decide: waiting.some((r) => r.you.accept || r.you.reject),
    status: waiting.length > 0 ? "open" : "decided",
    created_at: runs.reduce((a, r) => (new Date(r.created_at).getTime() < new Date(a).getTime() ? r.created_at : a), first.created_at),
    updated_at: latest.updated_at,
  };
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
  let rows: InboxRow[];
  if (filter !== "attention" && filter !== "waiting") rows = await withAgentNames(ctx, await list(filter));
  else {
    // The query counts an owner or admin outside a run's approver groups among those who may approve
    // it; they stand in only while nobody else may, which withAgentNames works out. Such a run waits on others.
    const needs = await withAgentNames(ctx, await list("attention"));
    if (filter === "attention") rows = needs.filter(asksCaller);
    else {
      const others = [...(await withAgentNames(ctx, await list("waiting"))), ...needs.filter((r) => !asksCaller(r) && waits(r))];
      const at = (r: InboxRow) => new Date(r.updated_at).getTime();
      others.sort((a, b) => at(b) - at(a) || b.run_id.localeCompare(a.run_id));
      rows = others.slice(0, limit ?? others.length);
    }
  }
  // The runs of a change are one row, under the tab all of them together put it in.
  const changeIds = [...new Set(rows.flatMap((r) => (r.change_id ? [r.change_id] : [])))];
  if (changeIds.length === 0) return json({ runs: rows, changes: [], filter });
  const siblings = await withAgentNames(
    ctx,
    await listAgentRuns(ctx.sql, {
      workspaceId: ctx.workspaceId,
      principals: ctx.principals,
      filter: "all",
      changeIds,
      limit: 200,
      decider: { alias: ctx.alias, admin: isWorkspaceAdmin(ctx) },
    }),
  );
  const changes = new Map((await getChanges(ctx.sql, changeIds)).map((c) => [c.change_id, c]));
  const grouped = changeIds
    .map((id) => ({ id, runs: siblings.filter((r) => r.change_id === id).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) }))
    .filter((g) => g.runs.length > 0 && (filter === "all" || tabOf(g.runs) === filter))
    .map((g) => changeRow(g.id, g.runs, changes.get(g.id), ctx.alias));
  return json({ runs: rows.filter((r) => !r.change_id), changes: grouped, filter });
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
