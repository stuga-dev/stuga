/**
 * The node-facing HTTP adapters over the run ledger. These trust their caller:
 * the node's gates decide who may propose, and compute `manager_override`.
 */
import type { AgentRunSource, AgentRunSummary, AiCitation, AiStrEdit } from "@stuga/protocol/wire/doc-socket";
import { clampRunLimit, parseReviewMode } from "@stuga/protocol/domain/runs";
import { applyStrEditsStrict } from "@stuga/crdt-ops";
import { proposeRunEdit, type ProposeAction } from "./propose.js";
import { pendingOf, RUN_LIST_DEFAULT_LIMIT, RUN_ORDER_MAX, type RunLedger, type StoredRun } from "./run-store.js";

const badRequest = () => Response.json({ error: "bad request" }, { status: 400 });

/**
 * Decisions (accept/reject, revert, dismiss) belong to the run's reviewer, or to
 * someone the node vouches for as the document's manager, so a run cannot strand
 * when its reviewer leaves. Fails closed on a missing actor.
 */
function notReviewer(stored: StoredRun, actor: string | undefined, managerOverride: unknown): Response | null {
  if (actor && (actor === stored.reviewer || managerOverride === true)) return null;
  return Response.json({ error: "not_reviewer", message: "only this run's reviewer can decide it" }, { status: 403 });
}

function runUnavailable(): Response {
  return Response.json(
    { error: "run_unavailable", message: "this run's contents could not be read; try again shortly" },
    { status: 503 },
  );
}

/** Maps `proposeRunEdit` onto the statuses the node's proposeDocEdit reads. */
export async function handleRunPropose(ledger: RunLedger, req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    text?: string;
    find?: string;
    replace?: string;
    replace_all?: boolean;
    edits?: AiStrEdit[];
    citations?: AiCitation[];
    source?: AgentRunSource;
    agent?: string;
    agent_alias?: string;
    reviewer?: string;
    workspace_id?: string;
    doc_title?: string;
    heading?: string | null;
    review?: string;
    client?: string | null;
    model?: string | null;
  } | null;
  const agentAlias = body?.agent_alias ?? "";
  const reviewer = body?.reviewer ?? "";
  if (!body || !agentAlias || !reviewer) return badRequest();

  let op: ProposeAction;
  if (body.action === "write") {
    if (typeof body.text !== "string") return badRequest();
    op = { action: "write", text: body.text };
  } else if (body.action === "append") {
    if (typeof body.text !== "string") return badRequest();
    op = { action: "append", text: body.text, heading: typeof body.heading === "string" ? body.heading : null };
  } else if (body.action === "str_replace") {
    if (!body.find) return badRequest();
    op = { action: "str_replace", find: body.find, replace: body.replace ?? "", replaceAll: body.replace_all === true };
  } else if (body.action === "cited_edits") {
    if (!Array.isArray(body.edits) || body.edits.length === 0) return badRequest();
    op = { action: "cited_edits", edits: body.edits, citations: Array.isArray(body.citations) ? body.citations : [] };
  } else {
    return badRequest();
  }

  const result = await proposeRunEdit(ledger, {
    op,
    source: body.source ?? "stdio",
    review: parseReviewMode(body.review),
    agent: body.agent || agentAlias,
    agentAlias,
    reviewer,
    workspaceId: body.workspace_id ?? "",
    docTitle: body.doc_title ?? "",
    client: typeof body.client === "string" ? body.client : null,
    model: typeof body.model === "string" ? body.model : null,
  });

  switch (result.mode) {
    case "noop":
      return Response.json({ mode: "noop" });
    case "proposed":
      return Response.json({
        mode: "proposed",
        run: result.run,
        pending: result.pending,
        parked_behind_pending: result.parkedBehindPending,
      });
    case "auto_applied":
      return Response.json({ mode: "auto_applied", run: result.run, seq: result.seq });
    case "error":
      return Response.json({ error: result.error, message: result.message, count: result.count }, { status: result.status });
  }
}

/**
 * The newest runs, open ones first. Bounded by `?limit=` because every row costs
 * a blob read.
 */
export async function handleRunList(ledger: RunLedger, url: URL): Promise<Response> {
  const order = await ledger.order();
  const limit = clampRunLimit(url.searchParams.get("limit"), RUN_ORDER_MAX, RUN_LIST_DEFAULT_LIMIT);
  const runs: AgentRunSummary[] = [];
  for (let i = order.length - 1; i >= 0 && runs.length < limit; i--) {
    const stored = await ledger.load(order[i]!);
    if (!stored) continue;
    runs.push(ledger.summaryOf(stored, await ledger.loadBody(stored)));
  }
  const open = runs.filter((r) => r.status === "open");
  const rest = runs.filter((r) => r.status !== "open");
  return Response.json({ runs: [...open, ...rest] });
}

export async function handleRunDetail(ledger: RunLedger, url: URL): Promise<Response> {
  const runId = url.searchParams.get("runId") ?? "";
  const stored = runId ? await ledger.load(runId) : null;
  if (!stored) return Response.json({ error: "not_found" }, { status: 404 });
  const body = await ledger.loadBody(stored);
  if (url.searchParams.get("full") !== "1") return Response.json({ run: ledger.summaryOf(stored, body) });
  return Response.json({
    run: ledger.summaryOf(stored, body),
    baseline_markdown: body.baseline_markdown,
    final_markdown: body.final_markdown ?? null,
    hunks: body.hunks,
  });
}

export async function handleRunDecide(ledger: RunLedger, req: Request): Promise<Response> {
  const store = ledger.store;
  await store.ensureLoaded();
  const input = (await req.json().catch(() => null)) as {
    run_id?: string;
    decision?: "accept" | "reject";
    hunk_ids?: string[];
    decided_by?: string;
    manager_override?: boolean;
  } | null;
  if (!input || !input.run_id || (input.decision !== "accept" && input.decision !== "reject")) return badRequest();
  const stored = await ledger.load(input.run_id);
  if (!stored) return Response.json({ error: "not_found" }, { status: 404 });
  const denied = notReviewer(stored, input.decided_by, input.manager_override);
  if (denied) return denied;
  const body = await ledger.loadBody(stored);
  // Without the hunk text there is nothing to decide, and closing would persist the empty body.
  if (ledger.bodyLost(stored, body)) return runUnavailable();
  const wanted = input.hunk_ids && input.hunk_ids.length > 0 ? new Set(input.hunk_ids) : null;
  const targets = body.hunks.filter((h) => h.status === "pending" && (!wanted || wanted.has(h.id)));
  const decidedBy = input.decided_by!;

  let appliedCount = 0;
  let conflictCount = 0;
  let blockedCount = 0;
  let decided = targets;
  if (targets.length > 0 && input.decision === "reject") {
    for (const h of targets) h.status = "rejected";
  } else if (targets.length > 0) {
    const current = store.markdown();
    const result = applyStrEditsStrict(current, targets);
    const applied = new Set(result.applied);
    // A hunk that misses while an earlier hunk of its run is still pending may
    // quote text that hunk produces: it stays pending ("blocked") rather than
    // becoming a conflict. Only a hunk with nothing pending ahead of it is a real conflict.
    const decidedNow = new Set(targets);
    const firstPending = body.hunks.findIndex((h) => h.status === "pending" && !decidedNow.has(h));
    const settled: typeof targets = [];
    for (let i = 0; i < targets.length; i++) {
      const h = targets[i]!;
      if (applied.has(i)) {
        h.status = "accepted";
      } else if (firstPending !== -1 && body.hunks.indexOf(h) > firstPending) {
        blockedCount++;
        continue;
      } else {
        h.status = "conflict";
        conflictCount++;
      }
      settled.push(h);
    }
    decided = settled;
    appliedCount = applied.size;
    // The accepting human gets version credit for what they let through.
    await store.commitMarkdown(ledger.commitTarget(result.markdown, body), current, { alias: decidedBy }, "run-large");
  }

  stored.updated_at = Date.now();
  // Only an open run closes; a late duplicate decision must not restamp a committed or reverted one.
  if (stored.status === "open" && pendingOf(body).length === 0) await ledger.close(stored, body);
  else await ledger.save(stored, body);
  ledger.sendDecided(stored, body, input.decision, decided.map((h) => h.id), decidedBy);
  ledger.emitEvent("run.decided", stored, `user:${decidedBy}`, "human", {
    decision: input.decision,
    decided_by: decidedBy,
    hunks: decided.length,
    applied: appliedCount,
    conflicts: conflictCount,
    pending: pendingOf(body).length,
  });
  return Response.json({
    run: ledger.summaryOf(stored, body),
    applied: appliedCount,
    conflicts: conflictCount,
    blocked: blockedCount,
  });
}

export async function handleRunRevert(ledger: RunLedger, req: Request): Promise<Response> {
  const store = ledger.store;
  await store.ensureLoaded();
  const input = (await req.json().catch(() => null)) as {
    run_id?: string;
    requested_by?: string;
    manager_override?: boolean;
  } | null;
  if (!input || !input.run_id) return badRequest();
  const stored = await ledger.load(input.run_id);
  if (!stored) return Response.json({ error: "not_found" }, { status: 404 });
  const denied = notReviewer(stored, input.requested_by, input.manager_override);
  if (denied) return denied;
  // A reverted run keeps its hunks' statuses, so without this a second revert would unwind again and report a conflict.
  if (stored.reverted) return Response.json({ error: "already_reverted" }, { status: 409 });
  const body = await ledger.loadBody(stored);
  if (ledger.bodyLost(stored, body)) return runUnavailable();
  const landed = body.hunks.filter((h) => h.status === "accepted" || h.status === "auto_applied");
  if (landed.length === 0) return Response.json({ error: "nothing_to_revert" }, { status: 409 });

  const requestedBy = input.requested_by!;
  // A landed deletion's inverse has an empty old_string, which means append: it
  // cannot be restored in place, so version history is the honest tool.
  if (landed.some((h) => h.new_string === "")) {
    return Response.json(
      { error: "conflict", message: "a deletion cannot be restored in place; use version history to restore" },
      { status: 409 },
    );
  }
  const current = store.markdown();
  // Unwind newest first, sides swapped: a later hunk may sit inside text an earlier one produced.
  const inverse = [...landed].reverse().map((h) => ({ old_string: h.new_string, new_string: h.old_string }));
  const result = applyStrEditsStrict(current, inverse);
  // All-or-nothing: a partial unwind is a state nobody authored.
  if (result.conflicts.length > 0) {
    return Response.json({ error: "conflict", message: "document has changed; use version history to restore" }, { status: 409 });
  }
  await store.commitMarkdown(ledger.commitTarget(result.markdown, body), current, { alias: requestedBy }, "run-large");
  // Reverting ends the run, so hunks still pending in it are rejected rather than stranded.
  const orphaned = pendingOf(body);
  for (const h of orphaned) h.status = "rejected";
  stored.status = "expired";
  stored.reverted = true;
  stored.acknowledged = true;
  stored.updated_at = Date.now();
  stored.seq_at_commit = store.seq;
  body.final_markdown = store.markdown();
  await ledger.save(stored, body);
  await ledger.clearActive(stored.agent_alias);
  ledger.sendDecided(stored, body, "reject", [...landed, ...orphaned].map((h) => h.id), requestedBy);
  ledger.emitEvent("run.reverted", stored, `user:${requestedBy}`, "human", {
    decided_by: requestedBy,
    reverted: landed.length,
    rejected: orphaned.length,
  });
  return Response.json({ run: ledger.summaryOf(stored, body), reverted: landed.length, rejected: orphaned.length });
}

/** Dismiss a catch-up card; only its reviewer may mark it read. */
export async function handleRunAck(ledger: RunLedger, req: Request): Promise<Response> {
  const input = (await req.json().catch(() => null)) as {
    run_id?: string;
    acked_by?: string;
    manager_override?: boolean;
  } | null;
  if (!input || !input.run_id) return badRequest();
  const stored = await ledger.load(input.run_id);
  if (!stored) return Response.json({ error: "not_found" }, { status: 404 });
  const denied = notReviewer(stored, input.acked_by, input.manager_override);
  if (denied) return denied;
  const body = await ledger.loadBody(stored);
  if (ledger.bodyLost(stored, body)) return runUnavailable();
  stored.acknowledged = true;
  stored.updated_at = Date.now();
  await ledger.save(stored, body);
  return Response.json({ ok: true });
}
