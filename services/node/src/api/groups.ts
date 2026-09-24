import { canonicalizeAlias } from "@stuga/auth";
import { upsertGroup } from "@stuga/db";
import { describeGroupSync } from "../audit/acl-diff.js";
import { recordAudit } from "../audit/record.js";
import { isWorkspaceAdmin } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/**
 * PUT /api/groups/:id { members: ["user:alice", ...] }: replace a group's
 * membership. Principals are resolved per request, so the change is in force on
 * every member's next request. Owner or admin of the active workspace only.
 */
export async function syncGroup({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  if (!isWorkspaceAdmin(ctx)) return error(403, "not authorized to sync groups");
  let groupId: string;
  try {
    groupId = decodeURIComponent(match[1]!);
  } catch {
    return error(400, "invalid group id");
  }
  const body = (await req.json().catch(() => ({}))) as { members?: string[] };
  if (!Array.isArray(body.members) || body.members.length > 10_000) {
    return error(400, "members must be an array of at most 10000 aliases");
  }
  const aliases = body.members.filter((member): member is string => typeof member === "string");
  if (aliases.length !== body.members.length || aliases.some((member) => member.length === 0 || member.length > 200)) {
    return error(400, "invalid group member");
  }
  // Canonicalized like any alias from outside, so one synced "Alice@x.com" is one entry whatever its case.
  const members = [
    ...new Set(
      aliases.map((member) => {
        const bare = member.startsWith("user:") ? member.slice("user:".length) : member;
        return `user:${canonicalizeAlias(bare)}`;
      }),
    ),
  ];
  const groupPrincipal = groupId.startsWith("group:") ? groupId : `group:${groupId}`;
  if (groupPrincipal.length > 200) return error(400, "group id too long");
  const previousMembers = await upsertGroup(ctx.sql, groupPrincipal, members, ctx.workspaceId);
  // Recorded as a permission change: who joined and who left.
  const change = describeGroupSync(previousMembers, members);
  if (change) {
    recordAudit(ctx, {
      action: "group.sync",
      targetKind: "group",
      targetId: groupPrincipal,
      detail: change,
    });
  }
  return json({ group_id: groupId, members: members.length });
}
