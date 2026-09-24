/** The node's administrator roster, and account recovery. */
import {
  countNodeAdmins,
  findAccountByUsername,
  grantNodeAdmin,
  listNodeAdmins,
  revokeNodeAdmin,
  searchAccounts,
} from "@stuga/db";
import { nodeAuditCtx, recordAudit } from "../../audit/record.js";
import { error, json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import { mintPasswordReset, resetUrl } from "../../identity/reset.js";

export async function listNodeAdminsRoute({ ctx }: WorkspaceCall): Promise<Response> {
  const admins = await listNodeAdmins(ctx.sql);
  return json({
    admins: admins.map((a) => ({
      alias: a.alias,
      display_name: a.display_name,
      username: a.username,
      email: a.email,
      granted_by: a.granted_by,
      granted_at: a.granted_at,
      source: "database" as const,
    })),
  });
}

/** The picker behind appointing and account recovery: every account on the node, names only, never emails. */
export async function searchNodeUsersRoute({ ctx, url }: WorkspaceCall): Promise<Response> {
  const users = await searchAccounts(ctx.sql, url.searchParams.get("q") ?? "");
  return json({ users });
}

/** Appointed by username only: never by a name or an email, which anyone can set. */
export async function grantNodeAdminRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { username?: unknown };
  const typed = typeof body.username === "string" ? body.username : "";
  if (!typed.trim()) return error(400, "a username is required");
  const account = await findAccountByUsername(ctx.sql, typed);
  if (!account) return error(400, "no such person on this node");
  const alias = account.alias;
  // Deleted between the lookup and the grant: the foreign key refuses it.
  const granted = await grantNodeAdmin(ctx.sql, alias, ctx.alias).catch(() => null);
  if (granted === null) return error(400, "no such person on this node");
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.admins.grant",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: { alias, already: !granted },
  });
  return json({ alias, granted });
}

export async function revokeNodeAdminRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  const alias = decodeURIComponent(match[1]!);
  // Someone must still administer the node afterwards.
  if ((await countNodeAdmins(ctx.sql)) <= 1) {
    return error(409, "this is the last node administrator; appoint another one first");
  }
  const revoked = await revokeNodeAdmin(ctx.sql, alias);
  if (!revoked) return error(404, "not a node administrator");
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.admins.revoke",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: { alias },
  });
  return json({ revoked: true });
}

/** Also how an account made through the identity provider gets a password when the provider is gone. */
export async function mintPasswordResetRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { username?: unknown };
  const username = typeof body.username === "string" ? body.username : "";
  if (!username.trim()) return error(400, "username is required");
  const account = await findAccountByUsername(ctx.sql, username);
  if (!account) return error(404, "no account with that username on this node");

  // Shown once; only its hash is stored. `stuga-node reset-password` mints the same link offline.
  const { token, expiresAt } = await mintPasswordReset(ctx.sql, {
    alias: account.alias,
    createdBy: ctx.alias,
  });
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.password_reset.mint",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    // Never the token.
    detail: { alias: account.alias, expires_at: expiresAt.toISOString() },
  });
  return json({ url: resetUrl(ctx.env.publicOrigin, token), alias: account.alias, username: account.username, expires_at: expiresAt });
}
