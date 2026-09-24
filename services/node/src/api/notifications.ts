/** The notification tray: its unread count, its rows, and marking them read. */
import { principalsFrom, userPrincipal } from "@stuga/auth";
import {
  type NotificationReach,
  listMembershipGroups,
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import { isNodeAdmin } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/**
 * The workspaces the caller's tray reads from, each with the principals that
 * gate its rows there: every membership for a person, the key's one workspace
 * for an agent.
 */
async function notificationReach(ctx: Ctx): Promise<NotificationReach> {
  if (ctx.isAgent) return { [ctx.workspaceId]: ctx.principals };
  const memberships = await listMembershipGroups(ctx.sql, ctx.alias, userPrincipal(ctx.alias));
  return Object.fromEntries(
    memberships.map((m) => [m.workspace_id, principalsFrom(ctx.alias, m.workspace_id, m.role, m.group_ids)]),
  );
}

// What the bell polls. Both reads gate each row on the caller's live principals
// in its workspace, since a notification quotes the resource it names. A row
// about the node itself is read only while its recipient still administers the node.
export async function unreadNotifications({ ctx }: WorkspaceCall): Promise<Response> {
  const reach = await notificationReach(ctx);
  return json({ unread: await unreadNotificationCount(ctx.sql, ctx.alias, reach, await isNodeAdmin(ctx)) });
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** ?limit as an integer clamped to 1..100; anything that is not an integer means the default. */
function listLimit(raw: string | null): number {
  const n = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(n)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, n));
}

export async function listNotificationsRoute({ ctx, url }: WorkspaceCall): Promise<Response> {
  const limit = listLimit(url.searchParams.get("limit"));
  const reach = await notificationReach(ctx);
  return json({ notifications: await listNotifications(ctx.sql, ctx.alias, reach, limit, await isNodeAdmin(ctx)) });
}

export async function markNotificationsReadRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  // The caller's own rows only. `before` is the newest created_at the client
  // holds, so a mark-all spares rows it has not displayed yet.
  const body = ((await req.json().catch(() => ({}))) ?? {}) as { ids?: unknown; before?: unknown };
  let ids: string[] | undefined;
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || body.ids.some((i) => typeof i !== "string")) {
      return error(400, "ids must be an array of notification ids");
    }
    ids = (body.ids as string[]).slice(0, 100);
    if (ids.length === 0) return json({ ok: true, updated: 0 });
  }
  let before: string | undefined;
  if (body.before !== undefined) {
    if (typeof body.before !== "string" || Number.isNaN(Date.parse(body.before))) {
      return error(400, "before must be a timestamp");
    }
    before = body.before;
  }
  const reach = await notificationReach(ctx);
  const updated = await markNotificationsRead(ctx.sql, ctx.alias, Object.keys(reach), ids, before, await isNodeAdmin(ctx));
  return json({ ok: true, updated });
}
