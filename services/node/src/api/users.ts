/** The workspace directory: display names for principals, and recipient search. */
import { type DocRow, type UserRow, getUsers, listWorkspaceMembers, searchUsers } from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import { guestForbidden, manages } from "../authz/authz.js";
import { authorizedDoc } from "../documents/access.js";
import { canOpenDoc } from "../mentions/recipients.js";
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
  const q = url.searchParams.get("q") ?? "";
  const docId = url.searchParams.get("doc");
  if (docId) return searchForMention(ctx, docId, q);
  const g = guestForbidden(ctx);
  if (g) return g;
  const rows = await searchUsers(ctx.sql, q, ctx.workspaceId);
  return json({ users: rows });
}

/** A person the mention list offers. */
type MentionCandidate = Pick<UserRow, "alias" | "username" | "display_name" | "email"> & { can_open: boolean };

/** As many people as the mention list shows. */
const MENTION_SUGGESTIONS = 8;
/** Matches weighed for a mention, so people who can open the document are not crowded out by those who cannot. */
const MENTION_CANDIDATES = 24;

/**
 * People to @mention in a document the caller can read, each marked with
 * whether they can open it, those who can first, never the caller. Under two
 * characters the list is the people who can open it, so `@` alone suggests
 * someone. A guest, who may not browse the directory, finds only people who can
 * open the document: whom it is shared with, which its Share dialog already
 * shows them. `readers_only` says when only such people were looked at, and
 * `can_share` whether the caller may share it with the rest.
 */
async function searchForMention(ctx: Ctx, docId: string, query: string): Promise<Response> {
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  const term = query.trim().replace(/^@/, "");
  const guest = ctx.role === "guest";
  let marked: MentionCandidate[];
  if (term.length >= 2) {
    const rows = await searchUsers(ctx.sql, term, ctx.workspaceId, MENTION_CANDIDATES);
    marked = [];
    for (const row of rows) {
      if (row.alias === ctx.alias) continue;
      const { alias, username, display_name, email } = row;
      marked.push({ alias, username, display_name, email, can_open: await canOpenDoc(ctx.sql, doc, alias) });
    }
  } else {
    marked = await readersStartingWith(ctx, doc, term.toLowerCase());
  }
  const users = [...marked.filter((u) => u.can_open), ...(guest ? [] : marked.filter((u) => !u.can_open))];
  // `readers_only`: only people who can open it were looked at, which the list says when nothing matches.
  const readersOnly = guest || term.length < 2;
  return json({ users: users.slice(0, MENTION_SUGGESTIONS), can_share: manages(ctx, doc), ...(readersOnly ? { readers_only: true } : {}) });
}

/** Members other than the caller who can open `doc`, by name, whose name or username starts with `prefix`. */
async function readersStartingWith(ctx: Ctx, doc: DocRow, prefix: string): Promise<MentionCandidate[]> {
  const members = await listWorkspaceMembers(ctx.sql, ctx.workspaceId);
  const out: MentionCandidate[] = [];
  for (const m of members) {
    if (m.alias === ctx.alias || m.display_name === null || m.username === null) continue;
    const words = [m.username, ...m.display_name.split(/\s+/)].map((w) => w.toLowerCase());
    if (prefix && !words.some((w) => w.startsWith(prefix))) continue;
    if (!(await canOpenDoc(ctx.sql, doc, m.alias, m.role))) continue;
    out.push({ alias: m.alias, username: m.username, display_name: m.display_name, email: m.email, can_open: true });
  }
  return out.sort((a, b) => a.display_name.localeCompare(b.display_name)).slice(0, MENTION_SUGGESTIONS);
}
