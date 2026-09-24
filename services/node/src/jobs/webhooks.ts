/** The workspace event feed's jobs: store an event and fan it out, then deliver it to each subscribed webhook. */
import { AiError } from "@stuga/ai";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { WEBHOOK_MAX_FAILURES, WEBHOOK_TIMEOUT_MS, signWebhookBody } from "../governance/webhooks/sign.js";
import { vetOutboundUrl } from "../net/outbound.js";
import type { JobDeps, JobsEnv } from "./deps.js";

/**
 * Append one event to the feed and queue one delivery per matching hook, so each
 * retries on its own clock. The document's folder ancestry is resolved once
 * here for folder-scoped hooks.
 */
export async function handleEvent(env: JobsEnv, deps: JobDeps, msg: Extract<IndexMessage, { kind: "event" }>): Promise<void> {
  const row = await deps.db.insertWorkspaceEvent({
    workspaceId: msg.workspaceId,
    type: msg.type,
    docId: msg.docId ?? null,
    actor: msg.actor,
    actorKind: msg.actorKind,
    payload: msg.payload ?? {},
  });
  if (!row) return;
  const ancestry = msg.docId ? await deps.db.docFolderAncestry(msg.docId) : [];
  const hooks = await deps.db.matchingWebhooks(msg.workspaceId, msg.type, ancestry);
  for (const hook of hooks) {
    await env.jobs.send({ kind: "webhook_deliver", webhookId: hook.webhook_id, eventId: row.id });
  }
}

/**
 * POST one event to one webhook, signed. A 5xx or network failure throws for a
 * retry; a 3xx or 4xx is terminal; a hook failing WEBHOOK_MAX_FAILURES times in
 * a row is switched off.
 */
export async function handleWebhookDeliver(deps: JobDeps, msg: Extract<IndexMessage, { kind: "webhook_deliver" }>): Promise<void> {
  const [hook, event] = await Promise.all([deps.db.getWebhook(msg.webhookId), deps.db.getWorkspaceEvent(msg.eventId)]);
  if (!hook || !hook.active || !event) return;
  const body = JSON.stringify({
    id: String(event.id),
    at: event.at,
    workspace_id: event.workspace_id,
    type: event.type,
    doc_id: event.doc_id,
    actor: event.actor,
    actor_kind: event.actor_kind,
    payload: event.payload,
  });
  // Vetted again at delivery: the name may resolve somewhere else than at registration.
  const verdict = await vetOutboundUrl(hook.url);
  if (!verdict.ok) {
    await deps.db.recordWebhookDelivery(hook.webhook_id, null, false);
    await deps.db.updateWebhook(hook.workspace_id, hook.webhook_id, { active: false });
    throw new AiError(`webhook ${hook.webhook_id} points at a refused address: ${verdict.reason}`, 400, false);
  }
  let status: number | null = null;
  try {
    const res = await deps.fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "stuga-webhook",
        "x-stuga-event": event.type,
        "x-stuga-delivery": `${event.id}:${hook.webhook_id}`,
        "x-stuga-signature": signWebhookBody(hook.secret, body),
      },
      body,
      // A followed redirect would deliver to an address that was never vetted.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    status = res.status;
  } catch (err) {
    await deps.db.recordWebhookDelivery(hook.webhook_id, null, false);
    await disableIfDark(deps, hook.webhook_id, hook.workspace_id, hook.failures + 1);
    throw new Error(`webhook ${hook.webhook_id} unreachable: ${String(err)}`);
  }
  const ok = status >= 200 && status < 300;
  await deps.db.recordWebhookDelivery(hook.webhook_id, status, ok);
  if (ok) return;
  await disableIfDark(deps, hook.webhook_id, hook.workspace_id, hook.failures + 1);
  if (status >= 300 && status < 400) {
    throw new AiError(`webhook ${hook.webhook_id} redirected (${status}); point it at its final address instead`, 400, false);
  }
  if (status >= 400 && status < 500) {
    throw new AiError(`webhook ${hook.webhook_id} answered ${status}`, status, false);
  }
  throw new Error(`webhook ${hook.webhook_id} answered ${status}`);
}

async function disableIfDark(deps: JobDeps, webhookId: string, workspaceId: string, failures: number): Promise<void> {
  if (failures < WEBHOOK_MAX_FAILURES) return;
  await deps.db.updateWebhook(workspaceId, webhookId, { active: false });
  deps.log.warn("webhook switched off after repeated failures", { webhookId, failures });
}
