/** The job worker: one handler per message kind, and the batch loop that acks, retries or drops each message. */
import { AiError } from "@stuga/ai";
import type { AuditEventInsert, JobBatch } from "@stuga/db";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { type JobDeps, type JobsEnv, isTerminal, jobDeps } from "./deps.js";
import { handleIndexDoc } from "./index-doc.js";
import { handleNotify, handleNotifyDeliver } from "./notify.js";
import { handleGcCheck } from "./snapshot-sweep.js";
import { handleEvent, handleWebhookDeliver } from "./webhooks.js";

export type AuditMessage = Extract<IndexMessage, { kind: "audit" }>;

export function auditRow(msg: AuditMessage): AuditEventInsert {
  const row: AuditEventInsert = {
    workspaceId: msg.workspaceId,
    actor: msg.actor,
    actorKind: msg.actorKind,
    source: msg.source,
    action: msg.action,
    // The sender's clock: when the action happened, not when the worker reached it.
    at: msg.at,
    status: msg.status,
  };
  if (msg.requestId !== undefined) row.requestId = msg.requestId;
  if (msg.onBehalfOf !== undefined) row.onBehalfOf = msg.onBehalfOf;
  if (msg.targetKind !== undefined) row.targetKind = msg.targetKind;
  if (msg.targetId !== undefined) row.targetId = msg.targetId;
  if (msg.targetLabel !== undefined) row.targetLabel = msg.targetLabel;
  if (msg.detail !== undefined) row.detail = msg.detail;
  return row;
}

async function handleAiUsage(deps: JobDeps, msg: Extract<IndexMessage, { kind: "ai_usage" }>): Promise<void> {
  const row: Parameters<JobDeps["db"]["insertAiUsage"]>[0] = {
    alias: msg.alias,
    workspaceId: msg.workspaceId,
    docId: msg.docId,
    kind: msg.usageKind,
    model: msg.model,
  };
  if (msg.status !== undefined) row.status = msg.status;
  if (msg.inputTokens !== undefined) row.inputTokens = msg.inputTokens;
  if (msg.outputTokens !== undefined) row.outputTokens = msg.outputTokens;
  if (msg.cacheReadTokens !== undefined) row.cacheReadTokens = msg.cacheReadTokens;
  if (msg.cacheWriteTokens !== undefined) row.cacheWriteTokens = msg.cacheWriteTokens;
  await deps.db.insertAiUsage(row);
}

/** Mirror one agent run into the workspace review inbox. */
export async function handleRunIndex(deps: JobDeps, msg: Extract<IndexMessage, { kind: "run_index" }>): Promise<void> {
  await deps.db.upsertAgentRun(msg.run);
}

/** Run one message to completion. */
export async function dispatchJob(env: JobsEnv, msg: IndexMessage, deps: Partial<JobDeps> = {}): Promise<void> {
  const d = jobDeps(env, deps);
  switch (msg.kind) {
    case "index_doc":
      return handleIndexDoc(env, d, msg);
    case "gc_check":
      return handleGcCheck(env, d, msg);
    case "notify":
      return handleNotify(env, d, msg);
    case "notify_deliver":
      return handleNotifyDeliver(env, d, msg);
    case "ai_usage":
      return handleAiUsage(d, msg);
    case "audit":
      return d.db.insertAuditEvents([auditRow(msg)]);
    case "run_index":
      return handleRunIndex(d, msg);
    case "event":
      return handleEvent(env, d, msg);
    case "webhook_deliver":
      return handleWebhookDeliver(d, msg);
    default:
      throw new AiError(`unknown job kind ${String((msg as { kind?: unknown }).kind)}`, 0, false);
  }
}

/**
 * The job worker's handler. A batch's audit messages are written with one
 * insert; the rest run in order. A terminal failure is acked and logged, a
 * transient one goes back on the queue.
 */
export async function handleJobBatch(env: JobsEnv, batch: JobBatch<IndexMessage>, deps: Partial<JobDeps> = {}): Promise<void> {
  const d = jobDeps(env, deps);
  const audits = batch.messages.filter((m) => m.body.kind === "audit");
  if (audits.length > 0) {
    try {
      await d.db.insertAuditEvents(audits.map((m) => auditRow(m.body as AuditMessage)));
      for (const m of audits) m.ack();
    } catch (err) {
      d.log.error("audit batch insert failed, retrying", { count: audits.length, err: String(err) });
      for (const m of audits) m.retry();
    }
  }
  for (const m of batch.messages) {
    if (m.body.kind === "audit") continue;
    try {
      await dispatchJob(env, m.body, d);
      m.ack();
    } catch (err) {
      if (isTerminal(err)) {
        d.log.error("job terminal failure, dropping", { kind: m.body.kind, id: m.id, err: String(err) });
        m.ack();
      } else {
        d.log.error("job transient failure, retrying", { kind: m.body.kind, id: m.id, attempts: m.attempts, err: String(err) });
        m.retry();
      }
    }
  }
}
