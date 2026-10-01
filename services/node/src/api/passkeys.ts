/**
 * A person's passkeys (docs/api.md): listed, renamed and removed at either address, added only at the
 * remote address (identity/passkey-routes.ts). Removing one ends the sign-ins it made, and closes
 * their sockets. Administrators never remove someone else's: Revoke everything does that.
 */
import { dismissPasskeyOffer, listPasskeys, removePasskey, renamePasskey } from "@stuga/db";
import { UNSAFE_TEXT, hasVisibleText } from "@stuga/protocol/domain/node-name";
import { recordAudit } from "../audit/record.js";
import { error, json } from "../http/respond.js";
import type { AccountCall } from "../http/router.js";
import { alertsFor } from "../identity/alerts.js";

const MAX_NAME = 64;

/** `{ passkeys: [{ id, name, synced, created_at, last_used_at }] }`, newest first. */
export async function listOwnPasskeys({ ctx }: AccountCall): Promise<Response> {
  const rows = await listPasskeys(ctx.sql, ctx.alias);
  // Only the remote address's own: a passkey for a host the node no longer has signs in nowhere.
  const host = ctx.env.remote?.current().hostname ?? null;
  return json({
    passkeys: rows.map((p) => ({
      id: p.credential_id,
      name: p.name,
      synced: p.backup_eligible,
      created_at: p.created_at,
      last_used_at: p.last_used_at,
      ...(host !== null && p.rp_id !== host ? { elsewhere: true } : {}),
    })),
  });
}

/** `{ name }`: what the person calls it, 1 to 64 printable characters. */
export async function renameOwnPasskey({ ctx, req, match }: AccountCall): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || !hasVisibleText(name)) return error(400, "a name is required");
  if (name.length > MAX_NAME) return error(400, `a name is at most ${MAX_NAME} characters`);
  if (UNSAFE_TEXT.test(name)) return error(400, "a name cannot contain control characters");
  const id = decodeURIComponent(match[1]!);
  if (!(await renamePasskey(ctx.sql, ctx.alias, id, name))) return error(404, "no such passkey");
  return json({ id, name });
}

/** Remove one of your passkeys: the sign-ins it made end, at once, with their sockets. */
export async function removeOwnPasskey({ ctx, match }: AccountCall): Promise<Response> {
  const id = decodeURIComponent(match[1]!);
  const removed = await removePasskey(ctx.sql, ctx.alias, id);
  if (!removed) return error(404, "no such passkey");
  ctx.env.sessionSockets.closeSessions(removed.sessionIds);
  recordAudit(ctx, {
    action: "node.passkey.remove",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: { name: removed.name, synced: removed.backup_eligible, sessions: removed.sessionIds.length },
  });
  await alertsFor(ctx.env).passkeyRemoved({ alias: ctx.alias, name: removed.name });
  // Whether this very sign-in was one of them, so the page knows to go back to signing in.
  return json({ removed: true, signed_out: removed.sessionIds.includes(ctx.isAgent ? "" : ctx.sid) });
}

/** "Not now" to "Sign in faster next time": never offered again, on any device. */
export async function dismissOwnPasskeyOffer({ ctx }: AccountCall): Promise<Response> {
  await dismissPasskeyOffer(ctx.sql, ctx.alias);
  return new Response(null, { status: 204 });
}
