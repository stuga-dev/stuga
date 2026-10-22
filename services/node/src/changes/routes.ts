/**
 * A change as people review it: one card for every page its agent touched for one piece of work, and
 * one decision for all of it.
 *
 * Who sees what follows each page. A reader sees the pages of a change they can open, and nothing of
 * the others, not even that they exist; each page's runs come as its own run routes give them, the
 * waiting text only to whoever reviews it there (RunJudge). The change's title and summary are the
 * agent's words about that waiting text, so they go only to someone who reads the waiting text of one
 * of its pages, or who asked for it.
 *
 * Approve all is no transaction: it approves, page by page and run by run, each run the caller may
 * approve now, through the gates a run's own decision takes, and reports per page what was approved
 * and what is left and why (asked by them, another's to approve, queued behind an earlier change,
 * locked). Ask for changes and Decline reject every run the caller may reject, each with the note.
 * A new page the change made is released once something of it is approved, and removed once all of
 * it is declined.
 */
import {
  type DocRow,
  type WikiChangePageRow,
  type WikiChangeRow,
  getChange,
  getChanges,
  getDoc,
  getFolderAncestors,
  listChangePages,
  listChangeRuns,
} from "@stuga/db";
import { isChangeId } from "@stuga/protocol/domain/changes";
import { stricterReviewMode, type ReviewMode } from "@stuga/protocol/domain/events";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { parseDecisionNote, type RunStanding } from "@stuga/protocol/domain/runs";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { agentNames } from "@stuga/db";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canReadDoc, canReadFolder, canWriteDoc } from "../authz/authz.js";
import { RunJudge, runDeciders, type RunDeciders, type RunVerdict } from "../authz/review-mode.js";
import { decideDocRunAs, forPerson as docRunForPerson, judgeRuns, type DecisionBlock } from "../api/runs.js";
import { decideDatabaseRunAs, forPerson as databaseRunForPerson, judgeDatabaseRuns } from "../databases/routes.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { releasePage, removePage } from "./held.js";
import { completeRun, itemsOf, type AnyRun } from "./actor-runs.js";


/** Why a run's waiting changes are left after Approve all, as the card says it. */
export type LeftReason = DecisionBlock | "own" | "colleague" | "group" | "reviewer" | "nobody";

/** One run of a page as the caller reads it, and where they stand on it. */
interface RunView {
  run: AnyRun;
  verdict: RunVerdict;
}

/** One page of a change as the caller reads it. */
export interface PageView {
  doc: DocRow;
  path: string[];
  runs: RunView[];
  /** The page is one the change made, and how it stands. */
  page: WikiChangePageRow | null;
  /** For a new page held with no run of the change yet: where the caller stands on approving it. */
  pageVerdict: RunVerdict | null;
  /** Runs of the change on it that could not be read now: nothing is settled as a page while any is. */
  unread: number;
  /** Whether the caller may decide one of its runs (before any narrowing): they read the change's title. */
  decides: boolean;
}

export interface ChangeView {
  change: WikiChangeRow;
  pages: PageView[];
  /** The caller reads the waiting text of one of its pages, or asked for it: they read its title and summary. */
  seesText: boolean;
}

/** How many of a run's items wait, read in full (completeRun), so a large run is never taken for decided. */
function pendingOf(run: AnyRun): number {
  return (itemsOf(run) ?? []).filter((i) => i.status === "pending").length;
}

const actorRun = completeRun;

/** The folders above a page the caller can read, by title, root first. */
async function folderPath(ctx: Ctx, doc: DocRow): Promise<string[]> {
  if (!doc.parent_id) return [];
  const chain = await getFolderAncestors(ctx.sql, doc.parent_id, doc.workspace_id);
  return chain.flatMap((f) => (canReadFolder(ctx, f) && f.title ? [f.title] : []));
}

/**
 * The change as `ctx` reads it: the pages they can open, in the order the agent first touched them,
 * each with its runs judged for them. A queued run's text is read only by someone who also reads the
 * text of every run it was proposed on top of, since its changes quote theirs.
 */
export async function loadChangeView(ctx: Ctx, change: WikiChangeRow): Promise<ChangeView> {
  const [runs, newPages] = await Promise.all([listChangeRuns(ctx.sql, change.change_id), listChangePages(ctx.sql, change.change_id)]);
  // In the order the agent first touched them: a page it made by when it made it, any other by its first run.
  const first = new Map<string, number>();
  for (const { doc_id, created_at } of [...newPages, ...runs]) {
    const at = new Date(created_at).getTime();
    if (!first.has(doc_id) || at < first.get(doc_id)!) first.set(doc_id, at);
  }
  const order = [...first.keys()].sort((a, b) => first.get(a)! - first.get(b)!);
  const pages: PageView[] = [];
  for (const docId of order) {
    const doc = await getDoc(ctx.sql, docId);
    if (!doc || doc.workspace_id !== ctx.workspaceId || !canReadDoc(ctx, doc)) continue;
    const page = newPages.find((p) => p.doc_id === docId) ?? null;
    // A page in the trash belongs on the card only as one the change made and lost.
    if (doc.trashed && page?.state !== "removed") continue;
    const summaries: AnyRun[] = [];
    let unread = 0;
    for (const r of runs.filter((x) => x.doc_id === docId)) {
      const run = await actorRun(ctx, doc, r.run_id);
      if (run) summaries.push(run);
      else unread++;
    }
    const judge = new RunJudge(ctx, doc);
    // Who decides a run reads the change's title, whether or not a queue narrows what they read of its text.
    const decides = (await judge.judgeAll(summaries)).some((v) => v.standing.accept || v.standing.reject || v.standing.queued === true);
    // Text a queued run quotes belongs to the runs it was proposed on top of: read only by who reads theirs.
    const verdicts =
      doc.doc_type === "database"
        ? await judgeDatabaseRuns(ctx, doc, summaries as DatabaseRunSummary[])
        : await judgeRuns(ctx, doc, summaries as AgentRunSummary[]);
    const pageVerdict =
      page && page.state === "held" ? await judge.judge({ reviewer: page.reviewer, review_mode: "colleague", approver_group: page.approver_group }) : null;
    pages.push({
      doc,
      path: await folderPath(ctx, doc),
      runs: summaries.map((run, i) => ({ run, verdict: verdicts[i]! })),
      page,
      pageVerdict,
      unread,
      decides: decides || (pageVerdict ? pageVerdict.standing.accept || pageVerdict.standing.reject : false),
    });
  }
  // The title and summary are the agent's words about waiting text: for whoever asked, and whoever decides
  // a run of it, as the inbox names its row.
  const seesText = change.on_behalf_of === ctx.alias || pages.some((p) => p.decides);
  return { change, pages, seesText };
}

/** A run as the caller reads it: its waiting text only where they review it. */
function runForPerson(run: AnyRun, v: RunVerdict): AnyRun {
  return "hunks" in run ? docRunForPerson(run, v) : databaseRunForPerson(run, v);
}

/** Why the caller may not approve a run that waits, or null when they may. */
export function leftReason(ctx: Ctx, doc: DocRow, run: AnyRun, you: RunStanding): LeftReason | null {
  if (you.accept && !doc.locked) return null;
  if (you.queued) return "queued";
  if (you.accept && doc.locked) return "locked";
  if (!canWriteDoc(ctx, doc)) return "view_only";
  if (you.level === "colleague") {
    if (ctx.alias === run.reviewer) return you.waits_for === "nobody" ? "nobody" : you.waits_for === "group" ? "group" : "own";
    return run.approver_group ? "group" : "colleague";
  }
  return "reviewer";
}

/** The level a page's waiting changes are decided at: the strictest of its runs', colleague for a held page with none. */
function pageLevel(p: PageView): ReviewMode {
  const levels = p.runs.map((r) => r.verdict.level);
  if (p.pageVerdict) levels.push(p.pageVerdict.level);
  return levels.reduce<ReviewMode>((a, b) => stricterReviewMode(a, b), levels[0] ?? "review");
}

/** One page as the card gets it. */
async function pageBody(ctx: Ctx, p: PageView): Promise<Record<string, unknown>> {
  const waiting = p.runs.filter((r) => r.run.status === "open" && pendingOf(r.run) > 0);
  const seesText = p.runs.some((r) => r.verdict.seesText) || (p.pageVerdict?.seesText ?? false);
  // Who may decide its waiting changes: named to whoever reads them, from the first run that waits.
  let deciders: RunDeciders | null = null;
  const first = waiting.find((r) => r.verdict.seesText);
  if (first) deciders = await runDeciders(ctx, p.doc, first.run, first.verdict);
  else if (p.pageVerdict?.seesText && p.page) {
    deciders = await runDeciders(ctx, p.doc, { reviewer: p.page.reviewer, review_mode: "colleague", approver_group: p.page.approver_group }, p.pageVerdict);
  }
  const behind = waiting.find((r) => r.run.queued_behind)?.run.queued_behind ?? null;
  return {
    doc_id: p.doc.doc_id,
    doc_kind: p.doc.doc_type === "database" ? "database" : "prose",
    title: p.doc.title,
    path: p.path,
    locked: p.doc.locked,
    level: pageLevel(p),
    new: p.page !== null,
    ...(p.page ? { state: p.page.state, ...(p.page.note && seesText ? { note: p.page.note } : {}) } : {}),
    runs: p.runs.map((r) => runForPerson(r.run, r.verdict)),
    ...(p.pageVerdict ? { page_you: p.pageVerdict.standing } : {}),
    ...(deciders ? { deciders } : {}),
    ...(behind ? { queued_behind: await queuedBehind(ctx, p.doc, behind) } : {}),
  };
}

/** The run a page's queued run waits behind, with its change's title for whoever may read it. */
async function queuedBehind(ctx: Ctx, doc: DocRow, runId: string): Promise<Record<string, unknown>> {
  const ahead = await actorRun(ctx, doc, runId);
  const changeId = ahead?.change_id ?? null;
  const change = changeId ? (await getChanges(ctx.sql, [changeId]))[0] : null;
  // Its title only to whoever may read that change's (their own, or one they review on this page).
  const verdict = ahead
    ? (doc.doc_type === "database" ? await judgeDatabaseRuns(ctx, doc, [ahead as DatabaseRunSummary]) : await judgeRuns(ctx, doc, [ahead as AgentRunSummary]))[0]!
    : null;
  return { run_id: runId, change_id: changeId, ...(change && verdict?.seesText ? { change_title: change.title } : {}) };
}

/** The change, or null when the caller may not know of it: none of its pages is one they can open. */
async function changeFor(ctx: Ctx, changeId: string): Promise<ChangeView | null> {
  if (!isChangeId(changeId)) return null;
  const change = await getChange(ctx.sql, changeId);
  if (!change || change.workspace_id !== ctx.workspaceId) return null;
  const view = await loadChangeView(ctx, change);
  return view.pages.length > 0 ? view : null;
}

/** GET /api/changes/:id: the change's card. */
export async function getChangeCard({ ctx, match }: WorkspaceCall): Promise<Response> {
  const view = await changeFor(ctx, match[1]!);
  if (!view) return error(404, "not found");
  const { change } = view;
  const names = await agentNames(ctx.sql, [change.agent_alias]);
  return json({
    change: {
      change_id: change.change_id,
      // The agent's words about waiting text, for whoever reads that text.
      title: view.seesText ? change.title : null,
      summary: view.seesText ? change.summary : null,
      agent: change.agent,
      agent_alias: change.agent_alias,
      agent_name: names.get(change.agent_alias) ?? change.agent,
      client: change.client,
      model: change.model,
      asked_by: change.on_behalf_of,
      created_at: change.created_at,
      updated_at: change.updated_at,
    },
    pages: await Promise.all(view.pages.map((p) => pageBody(ctx, p))),
  });
}

/** What a change decision did to one page. */
interface PageOutcome {
  doc_id: string;
  title: string;
  /** Changes it approved, or declined; conflicts that no longer applied; changes left waiting. */
  approved: number;
  declined: number;
  conflicts: number;
  left: number;
  /** Why what is left is left. */
  reasons: LeftReason[];
  /** For a new page the change made: how it stands now. */
  state?: string;
}

/**
 * POST /api/changes/:id/decision: `accept` approves every run of the change the caller may approve,
 * page by page, oldest run first; `reject` rejects every run they may reject, each with the note (Ask
 * for changes sends one, Decline may). Not atomic: each run is decided on its own, and the answer says
 * per page what was decided and what is left.
 */
export async function decideChange({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  if (ctx.isAgent) return error(403, "agents cannot review agent edits");
  const body = (await req.json().catch(() => ({}))) as { decision?: unknown; note?: unknown };
  if (body.decision !== "accept" && body.decision !== "reject") return error(400, "decision must be accept or reject");
  const decision = body.decision;
  const note = parseDecisionNote(decision, body.note);
  if (!note.ok) return error(400, note.message);
  const view = await changeFor(ctx, match[1]!);
  if (!view) return error(404, "not found");

  const pages: PageOutcome[] = [];
  for (const p of view.pages) {
    const out: PageOutcome = { doc_id: p.doc.doc_id, title: p.doc.title, approved: 0, declined: 0, conflicts: 0, left: 0, reasons: [] };
    const leave = (n: number, reason: LeftReason) => {
      out.left += n;
      if (!out.reasons.includes(reason)) out.reasons.push(reason);
    };
    const runs = [...p.runs].sort((a, b) => a.run.created_at - b.run.created_at);
    for (const { run, verdict } of runs) {
      const waiting = run.status === "open" ? pendingOf(run) : 0;
      if (waiting === 0) continue;
      const may = decision === "accept" ? verdict.standing.accept && !p.doc.locked : verdict.standing.reject;
      if (!may) {
        leave(waiting, decision === "accept" ? (leftReason(ctx, p.doc, run, verdict.standing) ?? "refused") : canWriteDoc(ctx, p.doc) ? "refused" : "view_only");
        continue;
      }
      const opts = note.note ? { note: note.note } : {};
      if ("hunks" in run) {
        const r = await decideDocRunAs(ctx, p.doc, run.id, decision, opts);
        if (!r.ok) leave(waiting, r.block);
        else if (decision === "accept") {
          out.approved += r.applied;
          out.conflicts += r.conflicts;
          if (r.blocked > 0) leave(r.blocked, "queued");
        } else out.declined += waiting;
      } else {
        const r = await decideDatabaseRunAs(ctx, p.doc, run.id, decision, opts);
        if (!r.ok) leave(waiting, r.block);
        else if (decision === "accept") {
          out.approved += r.applied;
          out.conflicts += r.conflicts;
          if (r.blocked > 0) leave(r.blocked, "queued");
        } else out.declined += r.rejected;
      }
    }
    // A new page settles with its runs; one holding no run left waiting is approved or declined as a page.
    if (p.page) {
      const fresh = await listChangePages(ctx.sql, view.change.change_id).then((all) => all.find((x) => x.doc_id === p.doc.doc_id) ?? null);
      if (fresh?.state === "held" && p.pageVerdict && out.left === 0 && p.unread === 0 && !(await anyWaiting(ctx, p))) {
        const doc = (await getDoc(ctx.sql, p.doc.doc_id)) ?? p.doc;
        if (decision === "accept" && p.pageVerdict.standing.accept && !doc.locked) await releasePage(ctx, fresh, doc);
        else if (decision === "reject" && p.pageVerdict.standing.reject && !doc.locked && !(await anyLanded(ctx, p))) await removePage(ctx, fresh, doc, note.note ?? null);
        else if (doc.locked) leave(0, "locked");
        else if (decision === "accept") leave(0, leftReason(ctx, doc, { reviewer: fresh.reviewer, approver_group: fresh.approver_group } as AnyRun, p.pageVerdict.standing) ?? "refused");
      }
      out.state = (await listChangePages(ctx.sql, view.change.change_id)).find((x) => x.doc_id === p.doc.doc_id)?.state;
    }
    pages.push(out);
  }
  recordAudit(ctx, {
    action: "change.decide",
    targetKind: "change",
    targetId: view.change.change_id,
    targetLabel: view.change.title,
    detail: {
      decision,
      pages: pages.length,
      approved: pages.reduce((n, p) => n + p.approved, 0),
      declined: pages.reduce((n, p) => n + p.declined, 0),
      left: pages.reduce((n, p) => n + p.left, 0),
      asked_by: view.change.on_behalf_of,
    },
  });
  return json({ change_id: view.change.change_id, decision, atomic: false, pages });
}

/** Whether a page's runs in the change still hold a waiting change, read again after the decisions. */
async function anyWaiting(ctx: Ctx, p: PageView): Promise<boolean> {
  for (const { run } of p.runs) {
    const now = await actorRun(ctx, p.doc, run.id);
    // One that cannot be read now may still wait.
    const items = now ? itemsOf(now) : null;
    if (!now || !items || (now.status === "open" && items.some((i) => i.status === "pending"))) return true;
  }
  return false;
}

/** Whether anything of a page's runs in the change landed. */
async function anyLanded(ctx: Ctx, p: PageView): Promise<boolean> {
  for (const { run } of p.runs) {
    const now = await actorRun(ctx, p.doc, run.id);
    const items = now ? itemsOf(now) : null;
    if (!items || items.some((i) => i.status === "accepted" || i.status === "auto_applied")) return true;
  }
  return false;
}
