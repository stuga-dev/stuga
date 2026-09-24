/** A document's agent runs: the review ledger humans decide on, and the propose path agents write through. */
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { parseCitedEdits, proposeBody, proposeDocEdit } from "../agents/edits.js";
import { recordAudit } from "../audit/record.js";
import { canWriteDoc, manages } from "../authz/authz.js";
import { authorizedDoc, lockedError, proseOnly } from "../documents/access.js";
import { docInstructionLabelsOrNone } from "../documents/instructions.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/** A document actor's run refusal as the client sees it: its reviewer gate stays a 403, the unexpected a 502. */
function runRefusal(res: Response, fallback: string): Response {
  if (res.status === 403) {
    return error(403, "only this agent run's reviewer (or the document's owner) can decide it");
  }
  return error(res.status === 404 ? 404 : 502, fallback);
}

export async function listDocRuns({ ctx, url, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (!proseOnly(await authorizedDoc(ctx, docId))) return error(404, "not found");
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
  // history. Deciding a run is gated separately.
  return json({ runs: ctx.isAgent ? runs.filter((r) => r.agent_alias === ctx.alias) : runs });
}

export async function getDocRun({ ctx, url, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (!proseOnly(await authorizedDoc(ctx, docId))) return error(404, "not found");
  const u = new URL("http://actor/runs/detail");
  u.searchParams.set("docId", docId);
  u.searchParams.set("runId", match[2]!);
  if (url.searchParams.get("full") === "1") u.searchParams.set("full", "1");
  const res = await ctx.env.docs.get(docId).fetch(u.toString());
  if (!res.ok) return error(res.status === 404 ? 404 : 502, "run unavailable");
  const detail = (await res.json()) as { run?: AgentRunSummary };
  // The list route's rule by id: another agent's run is indistinguishable from no run.
  if (ctx.isAgent && detail.run?.agent_alias !== ctx.alias) return error(404, "not found");
  return json(detail);
}

export async function decideDocRun({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (ctx.isAgent) return error(403, "agents cannot review agent edits");
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  if (!canWriteDoc(ctx, doc)) return error(403, "view-only access");
  const lk = lockedError(doc);
  if (lk) return lk;
  const body = (await req.json().catch(() => ({}))) as { decision?: string; hunk_ids?: unknown };
  if (body.decision !== "accept" && body.decision !== "reject") {
    return error(400, "decision must be accept or reject");
  }
  const hunkIds = Array.isArray(body.hunk_ids) ? body.hunk_ids.filter((h): h is string => typeof h === "string") : undefined;
  const res = await ctx.env.docs.get(docId).fetch(`http://actor/runs/decide?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run_id: match[2]!,
      decision: body.decision,
      hunk_ids: hunkIds,
      decided_by: ctx.alias,
      manager_override: manages(ctx, doc),
    }),
  });
  if (!res.ok) return runRefusal(res, "decision failed");
  const decided = (await res.json()) as { run?: AgentRunSummary; applied?: number; conflicts?: number };
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
    },
  });
  return json(decided);
}

export async function revertDocRun({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (ctx.isAgent) return error(403, "agents cannot revert agent edits");
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  if (!canWriteDoc(ctx, doc)) return error(403, "view-only access");
  const lk = lockedError(doc);
  if (lk) return lk;
  const res = await ctx.env.docs.get(docId).fetch(`http://actor/runs/revert?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run_id: match[2]!,
      requested_by: ctx.alias,
      manager_override: manages(ctx, doc),
    }),
  });
  // 409: the document moved on and nothing was reverted; passed through so the client can offer history.
  if (res.status === 409) return json(await res.json(), { status: 409 });
  if (!res.ok) return runRefusal(res, "revert failed");
  const reverted = (await res.json()) as { run?: AgentRunSummary; reverted?: number; rejected?: number };
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

export async function ackDocRun({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  if (ctx.isAgent) return error(403, "agents cannot acknowledge agent edits");
  const ackDoc = proseOnly(await authorizedDoc(ctx, docId));
  if (!ackDoc) return error(404, "not found");
  // Not write- or lock-gated: dismissing a card changes no text, and must work after access is withdrawn.
  const res = await ctx.env.docs.get(docId).fetch(`http://actor/runs/ack?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run_id: match[2]!,
      acked_by: ctx.alias,
      manager_override: manages(ctx, ackDoc),
    }),
  });
  if (!res.ok) return runRefusal(res, "ack failed");
  const acked = (await res.json()) as { run?: AgentRunSummary };
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
    source: "stdio",
  });
  if (outcome.kind === "error") return error(outcome.retryable ? 409 : (outcome.status ?? 400), outcome.message);
  // The stdio client does not know the app's origin.
  const answer = proposeBody(outcome, `${ctx.env.publicOrigin}/doc/${docId}`);
  if (!ctx.isAgent || outcome.kind === "noop") return json(answer);
  return json({ ...answer, ...(await docInstructionLabelsOrNone(ctx, outcome.doc)) });
}
