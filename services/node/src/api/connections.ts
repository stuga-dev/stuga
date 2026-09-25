/**
 * `/api/me/connections`: the apps a person signed in to this node through OAuth,
 * each a grant over the workspaces they chose. Account-level, since a grant
 * spans workspaces; the route table refuses agent credentials.
 */
import { listOauthGrants, revokeOauthGrant, updateOauthGrant, type OauthGrantRow } from "@stuga/db";
import { recordAudit } from "../audit/record.js";
import { error, json } from "../http/respond.js";
import type { AccountCall } from "../http/router.js";

const MAX_NAME_CHARS = 100;

function connectionView(g: OauthGrantRow) {
  return {
    grant_id: g.grant_id,
    agent_id: g.agent_id,
    name: g.name,
    client_id: g.client_id,
    /** The host that vouches for the app; null for one that registered itself. */
    verified_host: g.client_host,
    /** null = every workspace its person belongs to, now and later. */
    workspaces: g.workspace_scope,
    access: g.access,
    created_at: g.created_at,
    last_used_at: g.last_used_at,
    revoked_at: g.revoked_at,
  };
}

export type ConnectionView = ReturnType<typeof connectionView>;

export async function listConnections({ ctx }: AccountCall): Promise<Response> {
  return json({ connections: (await listOauthGrants(ctx.sql, ctx.alias)).map(connectionView) });
}

/** Rename a connection, or narrow it to read only; widening it is a new sign-in, where the person sees what they grant. */
export async function updateConnection({ ctx, req, match }: AccountCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; access?: unknown };
  const patch: { name?: string; access?: "read" } = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_CHARS) : "";
    if (!name) return error(400, "name cannot be empty");
    patch.name = name;
  }
  if (body.access !== undefined) {
    if (body.access !== "read") return error(400, "a connection can be narrowed to read only; sign in again to widen it");
    patch.access = "read";
  }
  const row = await updateOauthGrant(ctx.sql, match[1]!, ctx.alias, patch);
  if (!row) return error(404, "not found");
  recordAudit(ctx, { action: "connection.update", targetKind: "oauth_grant", targetId: row.grant_id, targetLabel: row.name, detail: { ...patch } });
  return json(connectionView(row));
}

export async function revokeConnection({ ctx, match }: AccountCall): Promise<Response> {
  const ok = await revokeOauthGrant(ctx.sql, match[1]!, ctx.alias);
  if (ok) recordAudit(ctx, { action: "connection.revoke", targetKind: "oauth_grant", targetId: match[1]! });
  // 404, not 403: the grant's existence is not disclosed.
  return ok ? json({ revoked: true }) : error(404, "not found");
}
