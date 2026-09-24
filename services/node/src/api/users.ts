/** The workspace directory: display names for principals, and recipient search. */
import { getUsers, searchUsers } from "@stuga/db";
import { guestForbidden } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/** Principals resolved per /api/users call; the client chunks larger sets. */
const MAX_USER_IDS = 200;

// ?ids=user:a,b,group:c: display names, usernames and emails for user principals, with or without the prefix.
export async function listUsers({ ctx, url }: WorkspaceCall): Promise<Response> {
  const raw = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length > MAX_USER_IDS) return error(400, "too many ids");
  const aliases = raw.map((p) => (p.startsWith("user:") ? p.slice("user:".length) : p));
  const rows = await getUsers(ctx.sql, aliases, ctx.workspaceId);
  return json({ users: rows });
}

// Share-dialog and mention autocomplete by username, name or email, so the client submits an alias.
export async function searchDirectory({ ctx, url }: WorkspaceCall): Promise<Response> {
  const g = guestForbidden(ctx);
  if (g) return g;
  const q = url.searchParams.get("q") ?? "";
  const rows = await searchUsers(ctx.sql, q, ctx.workspaceId);
  return json({ users: rows });
}
