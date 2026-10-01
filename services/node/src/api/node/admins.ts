/**
 * The node's administrator roster, and account recovery. Appointing an administrator, minting a
 * password link and revoking everything for someone each hand over a way in, so each takes a
 * sign-in confirmed in the last five minutes (identity/recency.ts).
 */
import {
  countNodeAdmins,
  findAccountByAlias,
  findAccountByUsername,
  getUserDisplayName,
  grantNodeAdmin,
  listNodeAdmins,
  revokeEverything,
  revokeEverythingCounts,
  revokeNodeAdmin,
  searchAccounts,
} from "@stuga/db";
import { nodeAuditCtx, recordAudit } from "../../audit/record.js";
import { error, json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import { alertsFor } from "../../identity/alerts.js";
import { deviceLabel } from "../../identity/devices.js";
import { recentConfirmationRequired } from "../../identity/recency.js";
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
  const stale = await recentConfirmationRequired(ctx);
  if (stale) return stale;
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
  const stale = await recentConfirmationRequired(ctx);
  if (stale) return stale;
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
  return json({ url: resetUrl(ctx.servedOrigin, token), alias: account.alias, username: account.username, expires_at: expiresAt });
}

/** The account `:alias` names, for Revoke everything; not oneself, who does it from Profile with a new password. */
async function recoveryTarget({ ctx, match }: WorkspaceCall) {
  const alias = decodeURIComponent(match[1]!);
  if (alias === ctx.alias) {
    return json({ error: "use_profile", message: "Revoke everything for yourself in Settings → Profile." }, { status: 400 });
  }
  const account = await findAccountByAlias(ctx.sql, alias);
  return account ?? error(404, "no such account on this node");
}

/** What Revoke everything would take from someone: `{ sessions, provider, apps, api_keys, invites, share_links }`. */
export async function revokeEverythingCountsRoute(call: WorkspaceCall): Promise<Response> {
  const account = await recoveryTarget(call);
  if (account instanceof Response) return account;
  const counts = await revokeEverythingCounts(call.ctx.sql, account.alias);
  return counts ? json(counts) : error(404, "no such account on this node");
}

/**
 * Revoke everything for someone (docs/api.md): every way into their account goes, their password
 * too, and the answer is a password link to hand them, the only way back in.
 */
export async function revokeEverythingForRoute(call: WorkspaceCall): Promise<Response> {
  const { ctx, req } = call;
  // Before the confirmation: someone picking themselves is told where to go, not asked to confirm first.
  const account = await recoveryTarget(call);
  if (account instanceof Response) return account;
  const stale = await recentConfirmationRequired(ctx);
  if (stale) return stale;

  const revoked = await revokeEverything(ctx.sql, { alias: account.alias, by: ctx.alias, passwordHash: null });
  if (!revoked) return error(404, "no such account on this node");
  ctx.env.sessionSockets.closeAccount(account.alias);
  const { token, expiresAt } = await mintPasswordReset(ctx.sql, { alias: account.alias, createdBy: ctx.alias });
  const { sessionIds: _ended, ...counts } = revoked;
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.account.revoke_everything",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: { alias: account.alias, ...counts, by_admin: true },
  });
  await alertsFor(ctx.env).revokedEverything({
    alias: account.alias,
    username: account.username,
    name: (await getUserDisplayName(ctx.sql, account.alias)) || account.username,
    device: deviceLabel(req.headers.get("user-agent")),
    at: new Date(),
    by: { alias: ctx.alias, name: ctx.displayName },
  });
  return json({ password_link: { url: resetUrl(ctx.servedOrigin, token), expires_at: expiresAt } });
}
