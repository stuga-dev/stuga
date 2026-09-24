/** Workspace webhooks: owner/admin administration of outbound event subscriptions. */
import { randomHex } from "@stuga/auth";
import { type WebhookRow, deleteWebhook, getFolder, insertWebhook, listWebhooks, updateWebhook } from "@stuga/db";
import { WORKSPACE_EVENT_TYPES, isWorkspaceEventType } from "@stuga/protocol/domain/events";
import { recordAudit } from "../../audit/record.js";
import type { Ctx } from "../../auth/context.js";
import { canReadFolder } from "../../authz/authz.js";
import { fingerprintUrl } from "../../config/settings/node.js";
import { error, json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import { newId } from "../../ids.js";
import { vetOutboundUrl } from "../../net/outbound.js";

/** A webhook as its manager sees it: everything but the secret, which is shown once at creation. */
function webhookView(w: WebhookRow) {
  return {
    webhook_id: w.webhook_id,
    url: w.url,
    events: w.events,
    folder_id: w.folder_id,
    active: w.active,
    created_by: w.created_by,
    created_at: w.created_at,
    last_delivery_at: w.last_delivery_at,
    last_status: w.last_status,
    failures: w.failures,
  };
}

/**
 * An absolute http(s) URL that does not resolve into the operator's network: a
 * workspace admin chooses the target of a signed outbound request. Vetted again
 * at delivery, since a name can resolve elsewhere later.
 */
async function validWebhookUrl(raw: unknown): Promise<{ url: string } | { error: string }> {
  if (typeof raw !== "string" || raw.length > 2048) return { error: "url must be an absolute http(s) URL" };
  const verdict = await vetOutboundUrl(raw);
  return verdict.ok ? { url: verdict.url.toString() } : { error: verdict.reason };
}

/** The folder a hook is scoped to, or null for the whole workspace; a folder the caller cannot read is not found. */
async function hookFolder(ctx: Ctx, raw: unknown): Promise<{ folderId: string | null } | Response> {
  const folderId = typeof raw === "string" && raw ? raw : null;
  if (!folderId) return { folderId };
  const folder = await getFolder(ctx.sql, folderId);
  return folder && canReadFolder(ctx, folder) ? { folderId } : error(404, "folder not found");
}

/** Accept a list of event types, or none for "every type". */
function parseEventTypes(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out = new Set<string>();
  for (const t of raw) {
    if (!isWorkspaceEventType(t)) return null;
    out.add(t);
  }
  return [...out];
}

export async function listWebhooksRoute({ ctx }: WorkspaceCall): Promise<Response> {
  const hooks = await listWebhooks(ctx.sql, ctx.workspaceId);
  return json({ webhooks: hooks.map(webhookView), event_types: WORKSPACE_EVENT_TYPES });
}

export async function createWebhook({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { url?: unknown; events?: unknown; folder_id?: unknown };
  const target = await validWebhookUrl(body.url);
  if ("error" in target) return error(400, target.error);
  const events = parseEventTypes(body.events);
  if (!events) return error(400, `events must be a list drawn from: ${WORKSPACE_EVENT_TYPES.join(", ")}`);
  const folder = await hookFolder(ctx, body.folder_id);
  if (folder instanceof Response) return folder;
  const { folderId } = folder;
  const secret = randomHex(32);
  const hook = await insertWebhook(ctx.sql, {
    webhookId: newId("whk_"),
    workspaceId: ctx.workspaceId,
    url: target.url,
    secret,
    events,
    folderId,
    createdBy: ctx.alias,
  });
  recordAudit(ctx, {
    action: "webhook.create",
    targetKind: "webhook",
    targetId: hook.webhook_id,
    // A webhook URL authorises by possession (often its path), so the ledger only ever holds a fingerprint.
    targetLabel: fingerprintUrl(hook.url),
    detail: { events, folder_id: folderId },
  });
  return json({ webhook: webhookView(hook), secret }, { status: 201 });
}

export async function updateWebhookRoute({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { url?: unknown; events?: unknown; folder_id?: unknown; active?: unknown };
  const patch: { url?: string; events?: string[]; folderId?: string | null; active?: boolean } = {};
  if (body.url !== undefined) {
    const target = await validWebhookUrl(body.url);
    if ("error" in target) return error(400, target.error);
    patch.url = target.url;
  }
  if (body.events !== undefined) {
    const events = parseEventTypes(body.events);
    if (!events) return error(400, `events must be a list drawn from: ${WORKSPACE_EVENT_TYPES.join(", ")}`);
    patch.events = events;
  }
  if (body.folder_id !== undefined) {
    const folder = await hookFolder(ctx, body.folder_id);
    if (folder instanceof Response) return folder;
    patch.folderId = folder.folderId;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return error(400, "active must be a boolean");
    patch.active = body.active;
  }
  const hook = await updateWebhook(ctx.sql, ctx.workspaceId, match[1]!, patch);
  if (!hook) return error(404, "not found");
  recordAudit(ctx, {
    action: "webhook.update",
    targetKind: "webhook",
    targetId: hook.webhook_id,
    targetLabel: fingerprintUrl(hook.url),
    detail: patch.url === undefined ? patch : { ...patch, url: fingerprintUrl(patch.url) },
  });
  return json({ webhook: webhookView(hook) });
}

export async function deleteWebhookRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  const ok = await deleteWebhook(ctx.sql, ctx.workspaceId, match[1]!);
  if (ok) recordAudit(ctx, { action: "webhook.delete", targetKind: "webhook", targetId: match[1]! });
  return ok ? json({ deleted: true }) : error(404, "not found");
}
