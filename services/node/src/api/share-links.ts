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
} from "@stuga/db";
import { isShareRole } from "@stuga/protocol/domain/roles";
import { recordAudit } from "../audit/record.js";
import type { AccountCtx } from "../auth/context.js";
import { manages } from "../authz/authz.js";
import { authorizedDoc, itemKind } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { AccountCall, WorkspaceCall } from "../http/router.js";
import { newId } from "../ids.js";

async function redeemDocShareLink(ctx: AccountCtx, token: string): Promise<Response> {
  return ctx.sql.begin(async (tx) => {
    // TransactionSql is the same tagged-query surface without the pool methods.
    const sql = tx as unknown as AccountCtx["sql"];
    const link = await getShareLink(sql, sha256Hex(token));
    if (!link) return error(400, "this share link is invalid, expired, or revoked");

    // Serialized per document, or two redemptions could each overwrite the other's grant.
    await sql`SELECT doc_id FROM docs WHERE doc_id = ${link.doc_id} FOR UPDATE`;
    const doc = await getDoc(sql, link.doc_id);
    if (!doc || doc.trashed || doc.workspace_id !== link.workspace_id) {
      return error(404, "document not found");
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
    return json({ doc_id: link.doc_id, workspace_id: link.workspace_id, role });
  });
}

export async function createShareLink({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can create share links");
  const body = (await req.json().catch(() => ({}))) as { role?: string; expires_in_days?: number };
  const role = body.role ?? "viewer";
  if (!isShareRole(role)) return error(400, "invalid role");
  const token = newId("shl_") + newId("");
  const tokenHash = sha256Hex(token);
  const expiresAt =
    typeof body.expires_in_days === "number" && body.expires_in_days > 0
      ? new Date(Date.now() + body.expires_in_days * 86400_000).toISOString()
      : null;
  await insertShareLink(ctx.sql, { tokenHash, docId, workspaceId: ctx.workspaceId, role, createdBy: ctx.alias, expiresAt });
  const linkUrl = `${ctx.env.publicOrigin}/s/${token}`;
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
  return json({ links: await listShareLinks(ctx.sql, docId) });
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

export async function redeemShareLink({ ctx, req }: AccountCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = (body.token ?? "").trim();
  if (!token) return error(400, "token required");
  return redeemDocShareLink(ctx, token);
}
