/** Who an @mention may notify: people who can read the document it is in. */
import { hasAccess } from "@stuga/auth";
import { type DocRow, type Sql, getMemberRole } from "@stuga/db";
import { resolvePrincipals } from "../auth/principals.js";

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
    const role = await getMemberRole(sql, doc.workspace_id, alias);
    if (!role) continue;
    const principals = await resolvePrincipals(sql, alias, doc.workspace_id, role);
    if (hasAccess(doc.acl_principals, principals)) out.push(alias);
  }
  return out;
}
