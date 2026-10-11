/** Who an @mention may notify: people who can read the document it is in. */
import { hasAccess, principalsFrom } from "@stuga/auth";
import { type DocRow, type Sql, getMemberRole } from "@stuga/db";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import { resolvePrincipals } from "../auth/principals.js";

/**
 * Whether a member of the document's workspace can read it. `role` is theirs
 * when the caller has it at hand. Their groups are read only when the document
 * is shared with a group, since a direct or workspace grant decides it alone.
 */
export async function canOpenDoc(
  sql: Sql,
  doc: Pick<DocRow, "workspace_id" | "acl_principals">,
  alias: string,
  role?: WorkspaceRole | null,
): Promise<boolean> {
  const r = role === undefined ? await getMemberRole(sql, doc.workspace_id, alias) : role;
  if (!r) return false;
  if (hasAccess(doc.acl_principals, principalsFrom(alias, doc.workspace_id, r, []))) return true;
  if (!doc.acl_principals.some((p) => p.startsWith("group:"))) return false;
  return hasAccess(doc.acl_principals, await resolvePrincipals(sql, alias, doc.workspace_id, r));
}

/**
 * The mentioned people who may read `doc`, in the order given, without the one
 * who wrote the mention. A mention never grants access, and a notification
 * about a document someone cannot open would leak its title and text to a
 * sink such as email.
 */
export async function mentionReaders(
  sql: Sql,
  doc: Pick<DocRow, "workspace_id" | "acl_principals">,
  aliases: readonly string[],
  author: string | null,
): Promise<string[]> {
  const out: string[] = [];
  for (const alias of new Set(aliases)) {
    if (alias === author) continue;
    if (await canOpenDoc(sql, doc, alias)) out.push(alias);
  }
  return out;
}
