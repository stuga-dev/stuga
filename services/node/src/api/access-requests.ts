/**
 * Requests for access, as the people who manage a document answer them: who asked and still cannot
 * open it, and dismissing a request. Approving is an ordinary share; a person who can open the
 * document drops off the list by themselves.
 */
import { hasAccess, principalsFrom, userPrincipal } from "@stuga/auth";
import { dismissAccessRequests, listAccessRequests, listMembershipGroups } from "@stuga/db";
import { manages } from "../authz/authz.js";
import { authorizedDoc } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

export async function listDocAccessRequests({ ctx, match }: WorkspaceCall): Promise<Response> {
  const doc = await authorizedDoc(ctx, match[1]!);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can see access requests");
  const requests = [];
  for (const request of await listAccessRequests(ctx.sql, ctx.workspaceId, doc.doc_id)) {
    // Someone who has left the workspace, or has been let in since, is no longer waiting.
    const membership = (await listMembershipGroups(ctx.sql, request.alias, userPrincipal(request.alias))).find(
      (m) => m.workspace_id === ctx.workspaceId,
    );
    if (!membership) continue;
    const principals = principalsFrom(request.alias, ctx.workspaceId, membership.role, membership.group_ids);
    if (hasAccess(doc.acl_principals, principals)) continue;
    requests.push({ principal: userPrincipal(request.alias), requested_at: request.requested_at });
  }
  return json({ requests });
}

export async function dismissDocAccessRequest({ ctx, match }: WorkspaceCall): Promise<Response> {
  const doc = await authorizedDoc(ctx, match[1]!);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can dismiss access requests");
  let principal: string;
  try {
    principal = decodeURIComponent(match[2]!);
  } catch {
    return error(400, "invalid principal");
  }
  if (!principal.startsWith("user:")) return error(400, "invalid principal");
  const dismissed = await dismissAccessRequests(ctx.sql, ctx.workspaceId, doc.doc_id, principal.slice("user:".length));
  return json({ dismissed });
}
