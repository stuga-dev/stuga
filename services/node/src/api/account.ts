/** `/api/whoami`: who the caller is, the name they go by, how to reach them, and how a person signs in. */
import { getSignInMethods, getUserEmail, getUsers, revokeEverythingCounts, setDisplayName, setUserEmail } from "@stuga/db";
import { isEmailShaped } from "@stuga/protocol/domain/username";
import { isNodeAdmin } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { AccountCall, WorkspaceCall } from "../http/router.js";
import { alertsFor } from "../identity/alerts.js";
import { deviceLabel } from "../identity/devices.js";
import { recentConfirmationRequired } from "../identity/recency.js";

export async function getWhoami({ ctx }: WorkspaceCall): Promise<Response> {
  // An agent has no directory row of its own, and its answer has no sign-in fields.
  const [row] = ctx.isAgent ? [] : await getUsers(ctx.sql, [ctx.alias], ctx.workspaceId);
  const methods = ctx.isAgent ? null : await getSignInMethods(ctx.sql, ctx.alias);
  return json({
    alias: ctx.alias,
    display_name: ctx.displayName,
    username: row?.username ?? null,
    email: row?.email ?? null,
    ...(methods ? { has_password: methods.hasPassword, provider_linked: methods.providerLinked } : {}),
    principals: ctx.principals,
    workspace_id: ctx.workspaceId,
    ...(ctx.scope
      ? { scope: { folders: ctx.scope.folders, read_only: ctx.scope.readOnly } }
      : {}),
    // Looked up here rather than in resolveHumanAuth, which runs on every request.
    node_admin: await isNodeAdmin(ctx),
  });
}

/**
 * The name other people see, and the optional contact address. Both belong to
 * the person: an identity provider's email only seeds an account made through it.
 * The address is where the node's alerts about their sign-ins go, so changing it
 * takes a sign-in confirmed in the last five minutes, and the person is told at the
 * address it was, and the node's administrators too.
 */
export async function updateWhoami({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { display_name?: unknown; email?: unknown };
  const out: { alias: string; display_name?: string; email?: string | null } = { alias: ctx.alias };

  let name: string | null = null;
  if ("display_name" in body) {
    name = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 100) : "";
    if (!name) return error(400, "a name is required");
  }

  let email: string | null | undefined;
  if ("email" in body) {
    const raw = body.email === null ? "" : typeof body.email === "string" ? body.email.trim() : undefined;
    if (raw === undefined) return error(400, "email must be a string or null");
    if (raw && !isEmailShaped(raw)) return error(400, `"${raw}" is not an email address`);
    email = raw || null;
  }

  if (name === null && email === undefined) return error(400, "a name is required");
  if (email !== undefined) {
    const stale = await recentConfirmationRequired(ctx);
    if (stale) return stale;
  }
  if (name !== null) {
    await setDisplayName(ctx.sql, ctx.alias, name);
    out.display_name = name;
  }
  if (email !== undefined) {
    const before = await getUserEmail(ctx.sql, ctx.alias);
    await setUserEmail(ctx.sql, ctx.alias, email);
    out.email = email;
    if ((before ?? null) !== email) {
      const [row] = await getUsers(ctx.sql, [ctx.alias], ctx.workspaceId);
      await alertsFor(ctx.env).emailChanged({
        alias: ctx.alias,
        username: row?.username ?? ctx.alias,
        name: name ?? ctx.displayName,
        device: deviceLabel(req.headers.get("user-agent")),
        at: new Date(),
        from: before,
        to: email,
      });
    }
  }
  return json(out);
}

/** What Revoke everything would take from the caller (POST /auth/revoke-everything does it). */
export async function getRevokeEverythingCounts({ ctx }: AccountCall): Promise<Response> {
  const counts = await revokeEverythingCounts(ctx.sql, ctx.alias);
  return counts ? json(counts) : error(404, "this account no longer exists");
}
