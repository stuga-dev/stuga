import type { Fragment } from "postgres";
import type { NotificationRow } from "./types.js";
import { daysAgo, jsonb, type Queryable } from "./sql.js";
import type { Sql } from "./client.js";

/**
 * Workspace id → the caller's principal set in that workspace. Kept per
 * workspace because `group:` principals are not tenant-qualified: a union would
 * let a group held in one workspace satisfy a same-named grant in another.
 */
export type NotificationReach = Record<string, string[]>;

/** The reach map as a relation. One jsonb parameter, because the principal sets are ragged. */
function notificationReachCte(sql: Sql, reach: NotificationReach): Fragment {
  return sql`
    WITH reach AS (
      SELECT key AS workspace_id, ARRAY(SELECT jsonb_array_elements_text(value)) AS principals
      FROM jsonb_each(${jsonb(sql, reach)}::jsonb)
    )`;
}

/**
 * Which rows the caller's tray reads: those of the workspaces in `reach`, and,
 * for a node administrator (`nodeRows`), those about the node itself, which
 * belong to no workspace.
 */
function readableWorkspace(sql: Sql, nodeRows: boolean): Fragment {
  return sql`AND (r.workspace_id IS NOT NULL OR (n.workspace_id IS NULL AND ${nodeRows}))`;
}

/**
 * A notification is readable only while its recipient can still see the doc or
 * folder it names, checked against the live ACL in the row's own workspace. A
 * row naming no resource always passes; one whose resource is gone is dropped.
 */
function visibleNotificationResource(sql: Sql): Fragment {
  return sql`
    AND (
      n.resource_id IS NULL
      OR EXISTS (SELECT 1 FROM docs d WHERE d.doc_id = n.resource_id
                   AND d.workspace_id = n.workspace_id AND d.acl_principals && r.principals)
      OR EXISTS (SELECT 1 FROM folders f WHERE f.folder_id = n.resource_id
                   AND f.workspace_id = n.workspace_id AND f.acl_principals && r.principals)
    )`;
}

/** `workspace_name` is null on a row about the node itself. */
export type NotificationListRow = NotificationRow & { workspace_name: string | null };

/**
 * The caller's notifications across every workspace in `reach`, newest first;
 * with `nodeRows`, those about the node itself too.
 */
export async function listNotifications(
  sql: Sql,
  recipient: string,
  reach: NotificationReach,
  limit = 20,
  nodeRows = false,
): Promise<NotificationListRow[]> {
  return sql<NotificationListRow[]>`
    ${notificationReachCte(sql, reach)}
    SELECT n.*, w.name AS workspace_name
    FROM notifications n
    LEFT JOIN reach r ON r.workspace_id = n.workspace_id
    LEFT JOIN workspaces w ON w.workspace_id = n.workspace_id
    WHERE n.recipient_alias = ${recipient}
    ${readableWorkspace(sql, nodeRows)}
    ${visibleNotificationResource(sql)}
    ORDER BY n.created_at DESC LIMIT ${Math.min(limit, 100)}`;
}

/** The unread count, behind the same gates as listNotifications so the badge agrees with the tray. */
export async function unreadNotificationCount(
  sql: Sql,
  recipient: string,
  reach: NotificationReach,
  nodeRows = false,
): Promise<number> {
  const rows = await sql<{ unread: number }[]>`
    ${notificationReachCte(sql, reach)}
    SELECT count(*)::int AS unread
    FROM notifications n
    LEFT JOIN reach r ON r.workspace_id = n.workspace_id
    WHERE n.recipient_alias = ${recipient} AND n.read = FALSE
    ${readableWorkspace(sql, nodeRows)}
    ${visibleNotificationResource(sql)}`;
  return rows[0]?.unread ?? 0;
}

/**
 * Mark the caller's notifications read in the given workspaces, and with
 * `nodeRows` those about the node itself; no resource gate, since flipping
 * `read` discloses nothing. `ids` limits it to rows; `before` (the newest
 * created_at the client holds) bounds a mark-all while still reaching unread
 * rows older than the list window. Returns rows flipped.
 */
export async function markNotificationsRead(
  sql: Sql,
  recipient: string,
  workspaceIds: string[],
  ids?: string[],
  before?: string,
  nodeRows = false,
): Promise<number> {
  if (workspaceIds.length === 0 && !nodeRows) return 0;
  const rows = await sql`
    UPDATE notifications SET read = TRUE
    WHERE recipient_alias = ${recipient}
      AND (workspace_id = ANY(${workspaceIds}) OR (workspace_id IS NULL AND ${nodeRows}))
      AND read = FALSE
      ${ids ? sql`AND id = ANY(${ids})` : sql``}
      ${
        // The client's watermark went through a JS Date, which keeps milliseconds only.
        before ? sql`AND date_trunc('milliseconds', created_at) <= ${before}` : sql``
      }
    RETURNING id`;
  return rows.count;
}

/** Delete notifications older than `days`, read or not, including rows with no workspace. */
export async function purgeOldNotifications(sql: Sql, days: number): Promise<number> {
  const rows = await sql`
    DELETE FROM notifications
    WHERE created_at < ${daysAgo(sql, days)}
    RETURNING id`;
  return rows.count;
}

/**
 * True when a new row was written; false when the id already existed or the
 * workspace is gone. Callers queue the sink delivery only on true.
 */
export async function insertNotification(sql: Queryable, n: Omit<NotificationRow, "read" | "created_at">): Promise<boolean> {
  const rows = await sql`
    INSERT INTO notifications
      (id, workspace_id, recipient_alias, event_type, resource_id, resource_title, resource_url, actor_alias, payload)
    SELECT ${n.id}, ${n.workspace_id}, ${n.recipient_alias}, ${n.event_type}, ${n.resource_id},
           ${n.resource_title}, ${n.resource_url}, ${n.actor_alias}, ${jsonb(sql, n.payload)}
    WHERE ${n.workspace_id}::text IS NULL OR EXISTS (SELECT 1 FROM workspaces WHERE workspace_id = ${n.workspace_id})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.count > 0;
}
