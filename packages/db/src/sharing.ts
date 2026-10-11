/** Document share links: capabilities redeemed by a signed-in user. Only a token's sha-256 is stored. */
import type { ShareLinkRow } from "./types.js";
import type { Sql } from "./client.js";

export async function insertShareLink(
  sql: Sql,
  input: {
    tokenHash: string;
    docId: string;
    workspaceId: string;
    role: string;
    createdBy: string;
    expiresAt: string | null;
    /** When the caller derives the token from the creation instant; the database's clock otherwise. */
    createdAt?: Date;
  },
): Promise<void> {
  await sql`
    INSERT INTO share_links ${sql({
      token_hash: input.tokenHash,
      doc_id: input.docId,
      workspace_id: input.workspaceId,
      role: input.role,
      created_by: input.createdBy,
      expires_at: input.expiresAt,
      ...(input.createdAt ? { created_at: input.createdAt } : {}),
    })}`;
}

/** The links that still open the document: neither revoked nor expired. Newest first. */
export async function listShareLinks(sql: Sql, docId: string): Promise<ShareLinkRow[]> {
  return sql<ShareLinkRow[]>`
    SELECT * FROM share_links
    WHERE doc_id = ${docId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC`;
}

export async function revokeShareLink(sql: Sql, tokenHash: string, docId: string): Promise<boolean> {
  const rows = await sql<{ token_hash: string }[]>`
    UPDATE share_links SET revoked_at = now()
    WHERE token_hash = ${tokenHash} AND doc_id = ${docId} AND revoked_at IS NULL
    RETURNING token_hash`;
  return rows.length > 0;
}

/**
 * A live link opens at `role` from now on, at the same address; people who already opened it keep
 * what it gave them. The role it had, or null when the document has no such live link.
 */
export async function setShareLinkRole(sql: Sql, tokenHash: string, docId: string, role: string): Promise<string | null> {
  const rows = await sql<{ before: string }[]>`
    UPDATE share_links s SET role = ${role}
    FROM (SELECT token_hash, role AS before FROM share_links
          WHERE token_hash = ${tokenHash} AND doc_id = ${docId}
            AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          FOR UPDATE) old
    WHERE s.token_hash = old.token_hash
    RETURNING old.before`;
  return rows[0]?.before ?? null;
}

/** A link that is neither revoked nor expired. */
export async function getShareLink(sql: Sql, tokenHash: string): Promise<ShareLinkRow | null> {
  const rows = await sql<ShareLinkRow[]>`
    SELECT * FROM share_links
    WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
  return rows[0] ?? null;
}
