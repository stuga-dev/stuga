/** A document's agent runs: the review ledger humans decide on, and the propose path agents write through. */
import { parseDecisionNote } from "@stuga/protocol/domain/runs";
import { RUN_FEEDBACK_REVISES_MAX } from "@stuga/protocol/domain/limits";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { DocRow } from "@stuga/db";
import type { RunAct } from "@stuga/protocol/domain/runs";
import type { Ctx } from "../auth/context.js";
import { parseCitedEdits, proposeBody, proposeDocEdit } from "../agents/edits.js";
import { recordAudit } from "../audit/record.js";
import { canWriteDoc } from "../authz/authz.js";
import { RunJudge, decisionRefusal, mayAct, narrowStacked, runDeciders, vouched, type RunVerdict } from "../authz/review-mode.js";
import { authorizedDoc, lockedError, proseOnly } from "../documents/access.js";
import { docInstructionLabelsOrNone } from "../documents/instructions.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { settleHeldPage } from "../changes/held.js";
import { changeArgsOf } from "../changes/resolve.js";
import { completeRun } from "../changes/actor-runs.js";

/**
 * A document actor's run refusal as the client sees it: its reviewer gate stays a 403, the
 * unexpected a 502. The actor refuses a run's reviewer at `colleague` on its own word too, when the
 * level rose after the node read the run.
 */
async function runRefusal(res: Response, fallback: string): Promise<Response> {
  const r = await actorRefusal(res, fallback);
  return error(r.status, r.message);
}

/** Why a decision did not go through, as the change card reports each page: whose it is not, or what stands in the way. */
export type DecisionBlock = "view_only" | "locked" | "refused" | "queued" | "gone";

/** The actor's refusal of a decision, as a status, words and the block it is. */
async function actorRefusal(res: Response, fallback: string): Promise<{ status: number; message: string; block: DecisionBlock }> {
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (res.status === 403) {
    if (body?.error === "own_run") return { status: 403, message: "a colleague approves these changes, not the person who asked the AI", block: "refused" };
    return { status: 403, message: "only this agent run's reviewer (or the document's owner) can decide it", block: "refused" };
  }
  // The run waits behind the agent's earlier changes here, which are decided first.
  if (res.status === 409 && body?.error === "queued") return { status: 409, message: body.message ?? "these changes wait behind earlier ones", block: "queued" };
  return { status: res.status === 404 ? 404 : 502, message: fallback, block: "gone" };
}

/** Hunks that landed: their text is in the document and its version history for any reader. */
const LANDED: ReadonlySet<string> = new Set(["accepted", "auto_applied"]);

/**
 * The run for a person, with where they stand on it (`you`). The text of a change that has not
 * landed (waiting, rejected or in conflict), with any note on it, goes only to its reviewer, its
 * approvers and the document's managers: anyone else who can read the document sees that the run
 * exists, how it went, and the changes that landed, never what an agent proposed before a person
 * let it in.
 */
export function forPerson(run: AgentRunSummary, v: RunVerdict): AgentRunSummary {
  const out: AgentRunSummary = { ...run, you: v.standing };
  if (v.seesText) return out;
  const hunks = run.hunks.filter((h) => LANDED.has(h.status));
  if (hunks.length === run.hunks.length && !run.hunks_truncated) return out;
  delete out.hunks_truncated;
  // How many wait, which the inbox shows every reader too, so the card can say whether any do.
  return { ...out, hunks, hunks_withheld: true, hunks_pending: run.hunks.filter((h) => h.status === "pending").length };
}

/** The run as the document's actor holds it, for a decision to read its reviewer and level from; null when there is none. */
async function actorRun(ctx: Ctx, docId: string, runId: string): Promise<AgentRunSummary | null | "unavailable"> {
  const u = new URL("http://actor/runs/detail");
  u.searchParams.set("docId", docId);
  u.searchParams.set("runId", runId);
  const res = await ctx.env.docs.get(docId).fetch(u.toString());
  if (res.status === 404) return null;
  if (!res.ok) return "unavailable";
  return ((await res.json()) as { run?: AgentRunSummary }).run ?? null;
}

/**
 * Read the run and judge whether the caller may do `act` on it, before the actor is asked: the
 * actor holds the run and re-checks, the node alone knows the document's level, its approvers and
 * who manages it. A refusal, or the verdict to forward.
 */
async function judgeAct(ctx: Ctx, doc: DocRow, runId: string, act: RunAct): Promise<Response | { run: AgentRunSummary; verdict: RunVerdict }> {
  const judged = await judgeRunAct(ctx, doc, runId, act);
  return "status" in judged ? error(judged.status, judged.message) : judged;
}

async function judgeRunAct(
  ctx: Ctx,
  doc: DocRow,
  runId: string,
  act: RunAct,
): Promise<{ status: number; message: string; block: DecisionBlock } | { run: AgentRunSummary; verdict: RunVerdict }> {
  const run = await actorRun(ctx, doc.doc_id, runId);
  if (run === "unavailable") return { status: 502, message: "run unavailable", block: "gone" };
  if (!run) return { status: 404, message: "not found", block: "gone" };
  const verdict = await judgeRun(ctx, doc, run);
  if (!mayAct(ctx, run, verdict, act)) return { status: 403, message: decisionRefusal(ctx, run, verdict, act, "document"), block: "refused" };
  return { run, verdict };
}

/** Where the caller stands on one run of `doc`, a queued run's text narrowed to whoever reads what it was stacked on. */
async function judgeRun(ctx: Ctx, doc: DocRow, run: AgentRunSummary): Promise<RunVerdict> {
  return (await judgeRuns(ctx, doc, [run]))[0]!;
}

/** judgeRun for every run of a document's list, with one approver lookup for all of them. */
export async function judgeRuns(ctx: Ctx, doc: DocRow, runs: readonly AgentRunSummary[]): Promise<RunVerdict[]> {
  const judge = new RunJudge(ctx, doc);
  const verdicts = await judge.judgeAll(runs);
  if (!runs.some((r) => r.stacked_on?.length)) return verdicts;
  return narrowStacked(ctx, judge, runs, verdicts, (id) => completeRun(ctx, doc, id) as Promise<AgentRunSummary | null>);
}

/** What a decision on one run came to: the actor's answer as the caller now stands on it, or why it did not go through. */
export type RunDecision =
  | { ok: true; run: AgentRunSummary; verdict: RunVerdict; applied: number; conflicts: number; blocked: number; answer: Record<string, unknown> }
  | { ok: false; status: number; message: string; block: DecisionBlock };

/**
 * Accept or reject a document run's waiting changes as `ctx`, through every gate the decision route
 * runs: write access, the lock (an accept only), who may act on it at its level (RunJudge, which the
 * actor checks again), and the queue (an accept of a run behind another waits). Recorded in the audit
 * ledger as the route records it.
 */
export async function decideDocRunAs(
  ctx: Ctx,
  doc: DocRow,
  runId: string,
  decision: "accept" | "reject",
  opts: { note?: string; hunkIds?: string[] } = {},
): Promise<RunDecision> {
  if (ctx.isAgent) return { ok: false, status: 403, message: "agents cannot review agent edits", block: "refused" };
  if (!canWriteDoc(ctx, doc)) return { ok: false, status: 403, message: "view-only access", block: "view_only" };
  // A lock holds the text as it is: accepting would change it, rejecting leaves it alone.
  if (decision === "accept" && doc.locked) return { ok: false, status: 423, message: "this document is locked; unlock it to make changes", block: "locked" };
  const judged = await judgeRunAct(ctx, doc, runId, decision);
  if ("status" in judged) return { ok: false, ...judged };
  const res = await ctx.env.docs.get(doc.doc_id).fetch(`http://actor/runs/decide?docId=${encodeURIComponent(doc.doc_id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run_id: runId,
      decision,
      hunk_ids: opts.hunkIds,
      decided_by: ctx.alias,
      ...vouched(judged.verdict),
      ...(opts.note ? { note: opts.note } : {}),
    }),
  });
  if (!res.ok) return { ok: false, ...(await actorRefusal(res, "decision failed")) };
  const decided = decidedFor((await res.json()) as { run?: AgentRunSummary; applied?: number; conflicts?: number; blocked?: number }, judged.verdict);
  // Who let an agent's edit into the document.
  recordAudit(ctx, {
    action: "run.decide",
    targetKind: "doc",
    targetId: doc.doc_id,
    targetLabel: doc.title,
    detail: {
      run_id: runId,
      decision,
      agent: decided.run?.agent ?? null,
      hunks: opts.hunkIds ? opts.hunkIds.length : (decided.run?.hunks?.length ?? 0),
      applied: decided.applied ?? 0,
      conflicts: decided.conflicts ?? 0,
      level: judged.verdict.level,
      // On whose behalf the agent proposed: at `colleague`, never the one who decided.
      asked_by: judged.run.reviewer,
    },
  });
  // A new page of a change is released once its changes are approved, or removed once they are declined.
  await settleHeldPage(ctx, doc, opts.note ?? null);
  return {
    ok: true,
    run: decided.run ?? judged.run,
    verdict: judged.verdict,
    applied: decided.applied ?? 0,
    conflicts: decided.conflicts ?? 0,
    blocked: decided.blocked ?? 0,
    answer: decided as Record<string, unknown>,
  };
}

/** A decision's answer, its run as the caller now stands on it. */
function decidedFor<T extends { run?: AgentRunSummary }>(answer: T, verdict: RunVerdict): T {
  return answer.run ? { ...answer, run: forPerson(answer.run, verdict) } : answer;
}

export async function listDocRuns({ ctx, url, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  const actorUrl = new URL("http://actor/runs");
  actorUrl.searchParams.set("docId", docId);
  // Each run costs the actor a blob read; it applies its own default and clamp.
  const limit = url.searchParams.get("limit");
  if (limit) actorUrl.searchParams.set("limit", limit);
  const res = await ctx.env.docs.get(docId).fetch(actorUrl.toString());
  if (!res.ok) return error(502, "runs unavailable");
  const data = (await res.json()) as { runs?: AgentRunSummary[] };
  const runs = data.runs ?? [];
  // An agent sees only its own runs; a reader sees the whole ledger, like version
  // history, each change's text only where they review it. Deciding a run is gated separately.
  if (ctx.isAgent) return json({ runs: runs.filter((r) => r.agent_alias === ctx.alias) });
  const verdicts = await judgeRuns(ctx, doc, runs);
  return json({ runs: runs.map((r, i) => forPerson(r, verdicts[i]!)) });
}

export async function getDocRun({ ctx, url, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  const u = new URL("http://actor/runs/detail");
  u.searchParams.set("docId", docId);
  u.searchParams.set("runId", match[2]!);
  if (url.searchParams.get("full") === "1") u.searchParams.set("full", "1");
  const res = await ctx.env.docs.get(docId).fetch(u.toString());
  if (!res.ok) return error(res.status === 404 ? 404 : 502, "run unavailable");
  const detail = (await res.json()) as {
    run?: AgentRunSummary;
    baseline_markdown?: string;
    final_markdown?: string | null;
    hunks?: AgentRunSummary["hunks"];
    citations?: unknown[];
  };
  // The list route's rule by id: another agent's run is indistinguishable from no run.
  if (ctx.isAgent) return detail.run?.agent_alias === ctx.alias ? json(detail) : error(404, "not found");
  if (!detail.run) return error(502, "run unavailable");
  const verdict = await judgeRun(ctx, doc, detail.run);
  // Whoever reads its waiting text also reads who may decide it: the review card names them.
  if (verdict.seesText) return json({ ...detail, run: forPerson(detail.run, verdict), deciders: await runDeciders(ctx, doc, detail.run, verdict) });
  // The document before and after its run, and the sources it cites, go with the text that did not
  // land; the hunks that did are anyone's.
  const run = forPerson(detail.hunks ? { ...detail.run, hunks: detail.hunks, hunks_truncated: undefined } : detail.run, verdict);
  return json(detail.hunks ? { run, hunks: run.hunks } : { run });
}

export async function decideDocRun({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (ctx.isAgent) return error(403, "agents cannot review agent edits");
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  if (!canWriteDoc(ctx, doc)) return error(403, "view-only access");
  const body = (await req.json().catch(() => ({}))) as { decision?: string; hunk_ids?: unknown; note?: unknown };
  if (body.decision !== "accept" && body.decision !== "reject") {
    return error(400, "decision must be accept or reject");
  }
  // A lock holds the text as it is: accepting would change it, rejecting leaves it alone.
  const lk = body.decision === "accept" ? lockedError(doc) : null;
  if (lk) return lk;
  const note = parseDecisionNote(body.decision, body.note);
  if (!note.ok) return error(400, note.message);
  const hunkIds = Array.isArray(body.hunk_ids) ? body.hunk_ids.filter((h): h is string => typeof h === "string") : undefined;
  const decided = await decideDocRunAs(ctx, doc, match[2]!, body.decision, { ...(note.note ? { note: note.note } : {}), ...(hunkIds ? { hunkIds } : {}) });
  if (!decided.ok) return error(decided.status, decided.message);
  return json(decided.answer);
}

export async function revertDocRun({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (ctx.isAgent) return error(403, "agents cannot revert agent edits");
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  if (!canWriteDoc(ctx, doc)) return error(403, "view-only access");
  const lk = lockedError(doc);
  if (lk) return lk;
  // The body is optional: a bare revert takes none.
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  const note = parseDecisionNote("revert", body.note);
  if (!note.ok) return error(400, note.message);
  const judged = await judgeAct(ctx, doc, match[2]!, "revert");
  if (judged instanceof Response) return judged;
  const res = await ctx.env.docs.get(docId).fetch(`http://actor/runs/revert?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run_id: match[2]!,
      requested_by: ctx.alias,
      ...vouched(judged.verdict),
      ...(note.note ? { note: note.note } : {}),
    }),
  });
  // 409: the document moved on and nothing was reverted; passed through so the client can offer history.
  if (res.status === 409) return json(await res.json(), { status: 409 });
  if (!res.ok) return await runRefusal(res, "revert failed");
  const reverted = decidedFor((await res.json()) as { run?: AgentRunSummary; reverted?: number; rejected?: number }, judged.verdict);
  // A revert rejects what still waited: a new page of a change with nothing landed goes.
  await settleHeldPage(ctx, doc, note.note ?? null);
  recordAudit(ctx, {
    action: "run.revert",
    targetKind: "doc",
    targetId: docId,
    targetLabel: doc.title,
    detail: {
      run_id: match[2]!,
      agent: reverted.run?.agent ?? null,
      hunks: reverted.reverted ?? 0,
    },
  });
  return json(reverted);
}

/** Undo a decision on `hunk_ids`: they wait for review again. 409 when the document or the agent moved on. */
export async function undoDocRun({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (ctx.isAgent) return error(403, "agents cannot review agent edits");
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  if (!canWriteDoc(ctx, doc)) return error(403, "view-only access");
  // A lock holds the text: undoing a rejection leaves it alone, so only the actor, which knows each
  // change's decision, can tell whether an undo would take accepted text back out.
  const body = (await req.json().catch(() => ({}))) as { hunk_ids?: unknown };
  const hunkIds = Array.isArray(body.hunk_ids) ? body.hunk_ids.filter((h): h is string => typeof h === "string") : [];
  if (hunkIds.length === 0) return error(400, "hunk_ids must list the changes to undo");
  const judged = await judgeAct(ctx, doc, match[2]!, "undo");
  if (judged instanceof Response) return judged;
  const res = await ctx.env.docs.get(docId).fetch(`http://actor/runs/undo?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: match[2]!, hunk_ids: hunkIds, requested_by: ctx.alias, ...vouched(judged.verdict), locked: doc.locked }),
  });
  if (res.status === 423) return lockedError(doc) ?? error(423, "this document is locked; unlock it to make changes");
  if (res.status === 409) return json(await res.json(), { status: 409 });
  if (!res.ok) return await runRefusal(res, "undo failed");
  const undone = decidedFor((await res.json()) as { run?: AgentRunSummary; reopened?: number }, judged.verdict);
  recordAudit(ctx, {
    action: "run.undo",
    targetKind: "doc",
    targetId: docId,
    targetLabel: doc.title,
    detail: { run_id: match[2]!, agent: undone.run?.agent ?? null, hunks: undone.reopened ?? 0 },
  });
  return json(undone);
}

export async function ackDocRun({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (ctx.isAgent) return error(403, "agents cannot acknowledge agent edits");
  const ackDoc = proseOnly(await authorizedDoc(ctx, docId));
  if (!ackDoc) return error(404, "not found");
  // Not write- or lock-gated: dismissing a card changes no text, and must work after access is withdrawn.
  // At `colleague` only someone other than the person who asked marks it reviewed, an approver or a manager.
  const judged = await judgeAct(ctx, ackDoc, match[2]!, "ack");
  if (judged instanceof Response) return judged;
  const res = await ctx.env.docs.get(docId).fetch(`http://actor/runs/ack?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run_id: match[2]!,
      acked_by: ctx.alias,
      ...vouched(judged.verdict),
    }),
  });
  if (!res.ok) return await runRefusal(res, "ack failed");
  const acked = decidedFor((await res.json()) as { run?: AgentRunSummary }, judged.verdict);
  // The only record that anyone looked at an auto-applied run.
  recordAudit(ctx, {
    action: "run.ack",
    targetKind: "doc",
    targetId: docId,
    targetLabel: ackDoc.title,
    detail: { run_id: match[2]!, agent: acked.run?.agent ?? null },
  });
  return json(acked);
}

// The REST write path for agents (the stdio MCP server); humans edit through the editor.
export async function proposeEdit({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (!ctx.isAgent) return error(403, "only agents propose edits");
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    text?: string;
    heading?: string | null;
    find?: string;
    replace?: string;
    replace_all?: boolean;
    edits?: unknown;
    citations?: unknown;
    revises?: unknown;
    change_id?: unknown;
    change_title?: unknown;
    change_summary?: unknown;
  };
  if (
    body.action !== "write" &&
    body.action !== "str_replace" &&
    body.action !== "append" &&
    body.action !== "cited_edits"
  ) {
    return error(400, "action must be write, str_replace, append or cited_edits");
  }
  // Validated here because the actor trusts the node.
  let cited: Extract<ReturnType<typeof parseCitedEdits>, { edits: unknown }> | undefined;
  if (body.action === "cited_edits") {
    const parsed = parseCitedEdits(body.edits, body.citations);
    if ("error" in parsed) return error(400, parsed.error);
    cited = parsed;
  }
  const outcome = await proposeDocEdit(ctx, {
    docId,
    action: body.action,
    text: body.text,
    heading: typeof body.heading === "string" ? body.heading : null,
    find: body.find,
    replace: body.replace,
    replaceAll: body.replace_all,
    edits: cited?.edits,
    citations: cited?.citations,
    revises: Array.isArray(body.revises) ? body.revises.filter((id): id is string => typeof id === "string").slice(0, RUN_FEEDBACK_REVISES_MAX) : undefined,
    source: "stdio",
    change: changeArgsOf(body),
  });
  if (outcome.kind === "error") return error(outcome.retryable ? 409 : (outcome.status ?? 400), outcome.message);
  // The stdio client does not know the app's origin.
  const answer = proposeBody(outcome, `${ctx.servedOrigin}/doc/${docId}`);
  if (!ctx.isAgent || outcome.kind === "noop") return json(answer);
  return json({ ...answer, ...(await docInstructionLabelsOrNone(ctx, outcome.doc)) });
}
