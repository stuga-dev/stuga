/** The workspace event feed's jobs: store an event and fan it out, then deliver it to each subscribed webhook. */
import { AiError } from "@stuga/ai";
import type { WebhookRow, WorkspaceEventRow } from "@stuga/db";
import { isReviewMode } from "@stuga/protocol/domain/events";
import { reviewCardPath } from "@stuga/protocol/domain/runs";
import { changeCardPath } from "@stuga/protocol/domain/changes";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { recipientLanguage } from "@stuga/protocol/notify/render";
import { WEBHOOK_MAX_FAILURES, WEBHOOK_TIMEOUT_MS, signWebhookBody } from "../governance/webhooks/sign.js";
import { OutboundRefusedError } from "../net/outbound.js";
import { slackChangePostBody, slackPostBody } from "../review/channel.js";
import type { JobDeps, JobsEnv } from "./deps.js";

/** What an event names that a review channel's post needs, read from a run event's payload. */
function runOf(
  event: Pick<WorkspaceEventRow, "payload">,
): { runId: string; changeId: string | null; reviewer: string; agent: string; title: string; review: string; pending: number } | null {
  const p = event.payload as Record<string, unknown>;
  if (typeof p.run_id !== "string" || typeof p.reviewer !== "string") return null;
  return {
    runId: p.run_id,
    changeId: typeof p.change_id === "string" ? p.change_id : null,
    reviewer: p.reviewer,
    agent: typeof p.agent === "string" ? p.agent : "",
    title: typeof p.doc_title === "string" ? p.doc_title : "",
    review: typeof p.review === "string" ? p.review : "",
    pending: typeof p.pending === "number" ? p.pending : 0,
  };
}

/**
 * Append one event to the feed and queue one delivery per matching hook, so each
 * retries on its own clock. The document's folder ancestry is resolved once
 * here for folder-scoped hooks. Every emitter's events pass here, so this is
 * where a hook is held to what its creator can read: a hook never hears of a
 * document its creator cannot open, whatever the event says of it (a title, a
 * comment's opening, a database's summary).
 */
export async function handleEvent(env: JobsEnv, deps: JobDeps, msg: Extract<IndexMessage, { kind: "event" }>): Promise<void> {
  const row = await deps.db.insertWorkspaceEvent({
    workspaceId: msg.workspaceId,
    type: msg.type,
    docId: msg.docId ?? null,
    actor: msg.actor,
    actorKind: msg.actorKind,
    payload: msg.payload ?? {},
    // The sender's clock where it stamped one: the worker reaches the message later.
    ...(msg.at === undefined ? {} : { at: msg.at }),
  });
  if (!row) return;
  const ancestry = msg.docId ? await deps.db.docFolderAncestry(msg.docId) : [];
  const hooks = await deps.db.matchingWebhooks(msg.workspaceId, msg.type, ancestry, msg.docId ?? null);
  for (const hook of hooks) {
    await env.jobs.send({ kind: "webhook_deliver", webhookId: hook.webhook_id, eventId: row.id });
  }
  // A review channel hears of a run once, when it first waits for a colleague, however many approvers
  // it has; of the runs of a change, once for the change.
  const run = runOf(row);
  if (msg.type !== "run.proposed" || !msg.docId || !run || run.review !== "colleague") return;
  for (const channel of await deps.db.matchingReviewChannels(msg.workspaceId, ancestry, msg.docId)) {
    await deps.db.claimReviewPost(channel.webhook_id, run.changeId ?? run.runId, { kind: "webhook_deliver", webhookId: channel.webhook_id, eventId: row.id });
  }
}

/**
 * The body a Slack review channel is sent about a run waiting for a colleague: the item's title now,
 * who asked, which AI, how many changes and the level, with the link to its review card, in the
 * language of the channel's creator. Null when there is nothing to post: the event names no run, or
 * the run was decided meanwhile.
 */
async function reviewPost(env: JobsEnv, deps: JobDeps, hook: WebhookRow, event: WorkspaceEventRow): Promise<string | null> {
  const run = runOf(event);
  if (event.type !== "run.proposed" || !event.doc_id || !run) return null;
  const change = run.changeId ? await deps.db.getChange(run.changeId) : null;
  if (change && change.workspace_id === event.workspace_id) {
    // A change is posted with its own title, never a page's, while something of it still waits.
    if (await deps.db.changeRunsClosed(change.change_id)) return null;
    const [author, language] = await Promise.all([deps.db.displayNameOf(run.reviewer), deps.db.uiLanguage(hook.created_by)]);
    const card = `${env.publicOrigin}${changeCardPath(change.change_id, event.workspace_id)}`;
    const words = { change: change.title, author: author || run.reviewer, agent: run.agent, level: "colleague" as const };
    return slackChangePostBody(words, card, recipientLanguage(language));
  }
  if (await deps.db.agentRunClosed(run.runId)) return null;
  // A page a change holds is posted only as part of a change, by the change's title: a run in none
  // would name the page to the channel.
  if (await deps.db.itemUnreleased(event.doc_id)) return null;
  const [doc, author, language] = await Promise.all([
    deps.db.getDoc(event.doc_id),
    deps.db.displayNameOf(run.reviewer),
    deps.db.uiLanguage(hook.created_by),
  ]);
  if (doc?.trashed) return null;
  const card = `${env.publicOrigin}${reviewCardPath(event.doc_id, run.runId, event.workspace_id)}`;
  const words = {
    doc: doc?.title ?? run.title,
    author: author || run.reviewer,
    agent: run.agent,
    count: run.pending,
    level: isReviewMode(run.review) ? run.review : "colleague",
  };
  return slackPostBody(words, card, recipientLanguage(language));
}

/**
 * POST one event to one webhook, signed. A 5xx, a 429 or a network failure throws for a
 * retry; any other 3xx or 4xx is terminal; a hook failing WEBHOOK_MAX_FAILURES times in
 * a row is switched off (a 429 is not a failure), and one at an address the node refuses
 * is switched off at once. Each attempt first asks again whether the hook's creator can read the
 * document, since a retry may come after they lost access or left.
 */
export async function handleWebhookDeliver(env: JobsEnv, deps: JobDeps, msg: Extract<IndexMessage, { kind: "webhook_deliver" }>): Promise<void> {
  const [hook, event] = await Promise.all([deps.db.getWebhook(msg.webhookId), deps.db.getWorkspaceEvent(msg.eventId)]);
  if (!hook || !hook.active || !event) return;
  if (!(await deps.db.webhookReaches(hook.webhook_id, event.doc_id))) return;
  // A review channel gets a line and a link, signed like any delivery; every other hook the event itself.
  const body =
    hook.kind === "slack"
      ? await reviewPost(env, deps, hook, event)
      : JSON.stringify({
          id: String(event.id),
          at: event.at,
          workspace_id: event.workspace_id,
          type: event.type,
          doc_id: event.doc_id,
          actor: event.actor,
          actor_kind: event.actor_kind,
          payload: event.payload,
        });
  if (body === null) return;
  let status: number | null = null;
  try {
    // Checked on the connection itself: the name may resolve elsewhere than at registration.
    const res = await deps.webhookFetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "stuga-webhook",
        "x-stuga-event": event.type,
        "x-stuga-delivery": `${event.id}:${hook.webhook_id}`,
        "x-stuga-signature": signWebhookBody(hook.secret, body),
      },
      body,
      // The signed body goes only where the hook says.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    status = res.status;
    await res.body?.cancel().catch(() => {});
    // Asked to slow down, as Slack asks past about a post a second: tried again later, counted as no failure.
    if (status === 429) throw new Error(`webhook ${hook.webhook_id} asked to slow down (429)`);
  } catch (err) {
    if (status === 429) throw err;
    await deps.db.recordWebhookDelivery(hook.webhook_id, null, false);
    if (err instanceof OutboundRefusedError) {
      await deps.db.updateWebhook(hook.workspace_id, hook.webhook_id, { active: false });
      throw new AiError(`webhook ${hook.webhook_id} points at a refused address: ${err.message}`, 400, false);
    }
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
