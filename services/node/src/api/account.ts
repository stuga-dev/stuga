/** `/api/whoami`: who the caller is, the name they go by, how to reach them, and how a person signs in. */
import { getSignInMethods, getUsers, setDisplayName, setUserEmail } from "@stuga/db";
import { isEmailShaped } from "@stuga/protocol/domain/username";
import { isNodeAdmin } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

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
  if (name !== null) {
    await setDisplayName(ctx.sql, ctx.alias, name);
    out.display_name = name;
  }
  if (email !== undefined) {
    await setUserEmail(ctx.sql, ctx.alias, email);
    out.email = email;
  }
  return json(out);
}
