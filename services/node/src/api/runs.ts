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
import { RunJudge, decisionRefusal, mayAct, runDeciders, vouched, type RunVerdict } from "../authz/review-mode.js";
import { authorizedDoc, lockedError, proseOnly } from "../documents/access.js";
import { docInstructionLabelsOrNone } from "../documents/instructions.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/**
 * A document actor's run refusal as the client sees it: its reviewer gate stays a 403, the
 * unexpected a 502. The actor refuses a run's reviewer at `colleague` on its own word too, when the
 * level rose after the node read the run.
 */
async function runRefusal(res: Response, fallback: string): Promise<Response> {
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "own_run") return error(403, "a colleague approves these changes, not the person who asked the AI");
    return error(403, "only this agent run's reviewer (or the document's owner) can decide it");
  }
  return error(res.status === 404 ? 404 : 502, fallback);
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
function forPerson(run: AgentRunSummary, v: RunVerdict): AgentRunSummary {
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
  const run = await actorRun(ctx, doc.doc_id, runId);
  if (run === "unavailable") return error(502, "run unavailable");
  if (!run) return error(404, "not found");
  const verdict = await new RunJudge(ctx, doc).judge(run);
  if (!mayAct(ctx, run, verdict, act)) return error(403, decisionRefusal(ctx, run, verdict, act, "document"));
  return { run, verdict };
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
  const verdicts = await new RunJudge(ctx, doc).judgeAll(runs);
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
  const verdict = await new RunJudge(ctx, doc).judge(detail.run);
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
  const judged = await judgeAct(ctx, doc, match[2]!, body.decision);
  if (judged instanceof Response) return judged;
  const res = await ctx.env.docs.get(docId).fetch(`http://actor/runs/decide?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run_id: match[2]!,
      decision: body.decision,
      hunk_ids: hunkIds,
      decided_by: ctx.alias,
      ...vouched(judged.verdict),
      ...(note.note ? { note: note.note } : {}),
    }),
  });
  if (!res.ok) return await runRefusal(res, "decision failed");
  const decided = decidedFor((await res.json()) as { run?: AgentRunSummary; applied?: number; conflicts?: number }, judged.verdict);
  // Who let an agent's edit into the document.
  recordAudit(ctx, {
    action: "run.decide",
    targetKind: "doc",
    targetId: docId,
    targetLabel: doc.title,
    detail: {
      run_id: match[2]!,
      decision: body.decision,
      agent: decided.run?.agent ?? null,
      hunks: hunkIds ? hunkIds.length : (decided.run?.hunks?.length ?? 0),
      applied: decided.applied ?? 0,
      conflicts: decided.conflicts ?? 0,
      level: judged.verdict.level,
      // On whose behalf the agent proposed: at `colleague`, never the one who decided.
      asked_by: judged.run.reviewer,
    },
  });
  return json(decided);
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
  });
  if (outcome.kind === "error") return error(outcome.retryable ? 409 : (outcome.status ?? 400), outcome.message);
  // The stdio client does not know the app's origin.
  const answer = proposeBody(outcome, `${ctx.servedOrigin}/doc/${docId}`);
  if (!ctx.isAgent || outcome.kind === "noop") return json(answer);
  return json({ ...answer, ...(await docInstructionLabelsOrNone(ctx, outcome.doc)) });
}
