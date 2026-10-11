/** Document share links: a capability minted by a manager and redeemed by a signed-in person. */
import { type OwnGrants, materializeAcl, sha256Hex } from "@stuga/auth";
import {
  addWorkspaceMember,
  folderEffectiveAcl,
  getDoc,
  getMemberRole,
  getShareLink,
  insertShareLink,
  listShareLinks,
  revokeShareLink,
  setDocAcl,
  setShareLinkRole,
  type DocRow,
} from "@stuga/db";
import { isShareRole } from "@stuga/protocol/domain/roles";
import { recordAudit } from "../audit/record.js";
import type { AccountCtx, Ctx } from "../auth/context.js";
import { signTicket } from "../auth/signed-ticket.js";
import { manages } from "../authz/authz.js";
import { authorizedDoc, itemKind } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { AccountCall, WorkspaceCall } from "../http/router.js";

/**
 * A link's token, derived from the internal secret, its document and the instant it was made, so
 * the node can hand a live link back to the people who manage the document without keeping the
 * token anywhere: Postgres holds only its hash, and a database dump opens nothing.
 */
function shareLinkToken(secret: string, docId: string, createdAt: Date): string {
  return `shl_${signTicket(secret, "share-link", `${docId}.${createdAt.toISOString()}`)}`;
}

/** A listed link's address, or null when its token is not the derived one (minted under another secret). */
function liveLinkUrl(ctx: Ctx, link: { token_hash: string; doc_id: string; created_at: string | Date }): string | null {
  const token = shareLinkToken(ctx.env.internalSecret, link.doc_id, new Date(link.created_at));
  return sha256Hex(token) === link.token_hash ? `${ctx.servedOrigin}/s/${token}` : null;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "23505";
}

/** A redemption that committed, as its audit row names it. */
interface Redeemed {
  workspaceId: string;
  doc: DocRow;
  role: string;
  /** The link made them a guest of the workspace. */
  joined: boolean;
}

async function redeemDocShareLink(ctx: AccountCtx, token: string): Promise<Response> {
  const { res, redeemed } = await ctx.sql.begin(async (tx): Promise<{ res: Response; redeemed?: Redeemed }> => {
    // TransactionSql is the same tagged-query surface without the pool methods.
    const sql = tx as unknown as AccountCtx["sql"];
    const link = await getShareLink(sql, sha256Hex(token));
    if (!link) return { res: error(400, "this share link is invalid, expired, or revoked") };

    // Serialized per document, or two redemptions could each overwrite the other's grant.
    await sql`SELECT doc_id FROM docs WHERE doc_id = ${link.doc_id} FOR UPDATE`;
    const doc = await getDoc(sql, link.doc_id);
    if (!doc || doc.trashed || doc.workspace_id !== link.workspace_id) {
      return { res: error(404, "document not found") };
    }

    const role = link.role;
    const existingRole = await getMemberRole(sql, link.workspace_id, ctx.alias);
    // A share link never grants more standing in the workspace than a guest's.
    if (!existingRole) await addWorkspaceMember(sql, link.workspace_id, ctx.alias, "guest");

    const principal = `user:${ctx.alias}`;
    const currentOwn = doc.own_grants;
    const own: OwnGrants = {
      p: [...new Set([...currentOwn.p, principal])],
      w: role === "editor" ? [...new Set([...currentOwn.w, principal])] : currentOwn.w,
      c:
        role === "commenter"
          ? [...new Set([...currentOwn.c, principal])]
          : role === "editor"
            ? currentOwn.c.filter((grant) => grant !== principal)
            : currentOwn.c,
    };
    const parentEffective =
      doc.inherits_perms && doc.parent_id
        ? await folderEffectiveAcl(sql, doc.parent_id, link.workspace_id)
        : null;
    const effective = materializeAcl(doc.owner, own, parentEffective, doc.inherits_perms);
    await setDocAcl(
      sql,
      link.doc_id,
      effective.principals,
      effective.writers,
      doc.inherits_perms,
      effective.commenters,
      own,
    );
    return {
      res: json({ doc_id: link.doc_id, workspace_id: link.workspace_id, role }),
      redeemed: { workspaceId: link.workspace_id, doc, role, joined: !existingRole },
    };
  });
  // The access a link gave, and a membership it made, are the ledger's like any other grant: after the commit.
  if (redeemed) {
    recordAudit(
      { ...ctx, workspaceId: redeemed.workspaceId },
      {
        action: "share_link.redeem",
        targetKind: itemKind(redeemed.doc),
        targetId: redeemed.doc.doc_id,
        targetLabel: redeemed.doc.title,
        detail: { role: redeemed.role, joined_as_guest: redeemed.joined },
      },
    );
  }
  return res;
}

export async function createShareLink({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can create share links");
  const body = (await req.json().catch(() => ({}))) as { role?: string; expires_in_days?: number };
  const role = body.role ?? "viewer";
  if (!isShareRole(role)) return error(400, "invalid role");
  const expiresAt =
    typeof body.expires_in_days === "number" && body.expires_in_days > 0
      ? new Date(Date.now() + body.expires_in_days * 86400_000).toISOString()
      : null;
  // Two links for one document in the same millisecond would share a token: the second moves on a millisecond.
  let createdAt = new Date();
  let token = shareLinkToken(ctx.env.internalSecret, docId, createdAt);
  for (let attempt = 0; ; attempt++) {
    try {
      const link = { tokenHash: sha256Hex(token), docId, workspaceId: ctx.workspaceId, role, createdBy: ctx.alias };
      await insertShareLink(ctx.sql, { ...link, expiresAt, createdAt });
      break;
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= 4) throw e;
      createdAt = new Date(createdAt.getTime() + 1);
      token = shareLinkToken(ctx.env.internalSecret, docId, createdAt);
    }
  }
  const linkUrl = `${ctx.servedOrigin}/s/${token}`;
  recordAudit(ctx, {
    action: "share_link.create",
    targetKind: itemKind(doc),
    targetId: docId,
    targetLabel: doc.title,
    detail: { role, expires_at: expiresAt },
  });
  return json({ token, link_url: linkUrl, role, expires_at: expiresAt }, { status: 201 });
}

export async function listDocShareLinks({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can view share links");
  const links = await listShareLinks(ctx.sql, docId);
  return json({
    links: links.map((link) => ({
      token_hash: link.token_hash,
      role: link.role,
      created_by: link.created_by,
      created_at: link.created_at,
      expires_at: link.expires_at,
      link_url: liveLinkUrl(ctx, link),
    })),
  });
}

export async function revokeDocShareLink({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const tokenHash = match[2]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can revoke share links");
  const revoked = await revokeShareLink(ctx.sql, tokenHash, docId);
  if (revoked) {
    recordAudit(ctx, {
      action: "share_link.revoke",
      targetKind: itemKind(doc),
      targetId: docId,
      targetLabel: doc.title,
    });
  }
  return revoked ? json({ revoked: true }) : error(404, "link not found");
}

/** A new level for a live link, at the same address, so a link already sent keeps working. */
export async function changeShareLinkRole({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const tokenHash = match[2]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can change share links");
  const body = (await req.json().catch(() => ({}))) as { role?: string };
  if (!isShareRole(body.role)) return error(400, "invalid role");
  const before = await setShareLinkRole(ctx.sql, tokenHash, docId, body.role);
  if (before === null) return error(404, "link not found");
  if (before !== body.role) {
    recordAudit(ctx, {
      action: "share_link.role",
      targetKind: itemKind(doc),
      targetId: docId,
      targetLabel: doc.title,
      detail: { before, after: body.role },
    });
  }
  return json({ token_hash: tokenHash, role: body.role });
}

export async function redeemShareLink({ ctx, req }: AccountCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = (body.token ?? "").trim();
  if (!token) return error(400, "token required");
  return redeemDocShareLink(ctx, token);
}
