/** A document's comment threads. */
import { deleteComment, getComment, listComments, setCommentResolved } from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import { canCommentDoc, manages } from "../authz/authz.js";
import { commentInput, isCommentRefusal, postComment } from "../comments/post.js";
import { commentAgents, markYours } from "../comments/read.js";
import { authorizedDoc, pushCommentsChanged } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

export async function listDocComments({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const cdoc = await authorizedDoc(ctx, docId);
  if (!cdoc) return error(404, "not found");
  const rows = await listComments(ctx.sql, docId);
  // Whether the caller may resolve or delete anyone's comment, so a page offers only what it may do.
  return json({ comments: markYours(ctx, rows), agents: await commentAgents(ctx.sql, rows), can_manage: manages(ctx, cdoc) });
}

/** A comment its caller wrote, or that their own co-author wrote for them. */
function ownComment(ctx: Ctx, author: string): boolean {
  return author === ctx.alias || author === `panel:${ctx.alias}`;
}

export async function addDocComment({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const cdoc = await authorizedDoc(ctx, docId);
  if (!cdoc) return error(404, "not found");
  // Writers and granted commenters may post; a viewer only reads.
  if (!canCommentDoc(ctx, cdoc)) {
    return error(403, "view-only access (ask for comment permission)");
  }
  const input = commentInput(((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>);
  if (typeof input === "string") return error(400, input);
  const out = await postComment(ctx, cdoc, input);
  if (isCommentRefusal(out)) return error(out.status, out.error);
  // Only an agent's notices can be held, so a person's answer is the comment as stored.
  return json({ ...out.comment, ...(out.suppressed > 0 ? { notifications_held: out.suppressed } : {}) }, { status: 201 });
}

export async function resolveDocComment({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const num = Number(match[2]);
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  const body = (await req.json().catch(() => ({}))) as { resolved?: boolean };
  if (typeof body.resolved !== "boolean") return error(400, "resolved must be a boolean");
  const existing = await getComment(ctx.sql, docId, num);
  if (!existing) return error(404, "comment not found");
  if (!ownComment(ctx, existing.author) && !manages(ctx, doc)) {
    return error(403, "only the comment author or doc owner can resolve this comment");
  }
  const updated = await setCommentResolved(ctx.sql, docId, num, body.resolved);
  if (!updated) return error(404, "comment not found");
  void pushCommentsChanged(ctx.env, docId, doc.doc_type);
  return json(updated);
}

export async function deleteDocComment({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const num = Number(match[2]);
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  const existing = await getComment(ctx.sql, docId, num);
  if (!existing) return error(404, "comment not found");
  if (!ownComment(ctx, existing.author) && !manages(ctx, doc)) {
    return error(403, "only the comment author or doc owner can delete this comment");
  }
  const deleted = await deleteComment(ctx.sql, docId, num);
  if (!deleted) return error(404, "comment not found");
  void pushCommentsChanged(ctx.env, docId, doc.doc_type);
  return json({ deleted: true });
}
