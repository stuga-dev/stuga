/** A document's comment threads. */
import { principalId, userPrincipal } from "@stuga/auth";
import { addComment, deleteComment, getComment, getMembersByUsername, listComments, setCommentResolved } from "@stuga/db";
import { MAX_MENTIONS, commentMentionCandidates } from "@stuga/protocol/domain/mentions";
import { recordEvent } from "../audit/record.js";
import { canCommentDoc, manages } from "../authz/authz.js";
import { authorizedDoc } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { mentionReaders } from "../mentions/recipients.js";

export async function listDocComments({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const cdoc = await authorizedDoc(ctx, docId);
  if (!cdoc) return error(404, "not found");
  return json({ comments: await listComments(ctx.sql, docId) });
}

export async function addDocComment({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const cdoc = await authorizedDoc(ctx, docId);
  if (!cdoc) return error(404, "not found");
  // Writers and granted commenters may post; a viewer only reads.
  if (!canCommentDoc(ctx, cdoc)) {
    return error(403, "view-only access (ask for comment permission)");
  }
  const body = (await req.json().catch(() => ({}))) as {
    body?: string;
    parent_num?: number | null;
    anchor_start?: string | null;
    anchor_end?: string | null;
    anchor_quote?: string | null;
  };
  if (typeof body.body !== "string" || !body.body.trim()) {
    return error(400, "comment body required");
  }
  const commentBody = body.body.trim();
  const anchorStart = typeof body.anchor_start === "string" ? body.anchor_start : null;
  const anchorEnd = typeof body.anchor_end === "string" ? body.anchor_end : null;
  const anchorQuote = typeof body.anchor_quote === "string" ? body.anchor_quote : null;
  if (commentBody.length > 20_000) return error(400, "comment too long");
  if ((anchorQuote ?? "").length > 2_000) return error(400, "anchor quote too long");
  if ((anchorStart ?? "").length > 1_000 || (anchorEnd ?? "").length > 1_000) {
    return error(400, "anchor too long");
  }
  // Threads are one level deep: a reply to a reply attaches to the thread head.
  let parentNum: number | null = null;
  if (body.parent_num !== undefined && body.parent_num !== null) {
    if (!Number.isSafeInteger(body.parent_num) || body.parent_num < 0) {
      return error(400, "invalid parent_num");
    }
    const parent = await getComment(ctx.sql, docId, body.parent_num);
    if (!parent) return error(400, "parent comment not found");
    parentNum = parent.parent_num ?? parent.num;
  }
  // @usernames that name a member of this workspace, in the order written.
  const candidates = commentMentionCandidates(commentBody);
  const members = new Map((await getMembersByUsername(ctx.sql, candidates, ctx.workspaceId)).map((m) => [m.username, m]));
  const mentions = candidates.flatMap((u) => members.get(u) ?? []).slice(0, MAX_MENTIONS);
  const c = await addComment(ctx.sql, {
    docId,
    author: ctx.alias,
    body: commentBody,
    parentNum,
    // addComment drops the anchor of a reply, which inherits its thread's.
    anchorStart,
    anchorEnd,
    anchorQuote,
    mentions,
  });
  recordEvent(ctx, "comment.added", docId, { num: c.num, parent_num: parentNum, excerpt: commentBody.slice(0, 140) });
  const actorName = ctx.displayName || ctx.alias;
  // The notify worker collapses a flurry of notifications into one per person, event and hour.
  const mentioned = await mentionReaders(ctx.sql, cdoc, mentions.map((m) => m.alias), ctx.alias);
  for (const recipient of mentioned) {
    await ctx.env.jobs.send({
      kind: "notify",
      recipient,
      workspaceId: ctx.workspaceId,
      eventType: "MENTIONED_IN_COMMENT",
      docId,
      title: `${actorName} mentioned you in a comment on "${cdoc.title}"`,
      body: commentBody.slice(0, 140),
      actor: ctx.alias,
    });
  }
  // An owner who was mentioned already has the more specific notification.
  if (
    cdoc.owner.startsWith("user:") &&
    cdoc.owner !== userPrincipal(ctx.alias) &&
    !mentioned.includes(principalId(cdoc.owner))
  ) {
    await ctx.env.jobs.send({
      kind: "notify",
      recipient: principalId(cdoc.owner),
      workspaceId: ctx.workspaceId,
      eventType: "COMMENT_ON_OWNED_DOC",
      docId,
      title: `${actorName} ${parentNum === null ? "commented on" : "replied on"} "${cdoc.title}"`,
      body: commentBody.slice(0, 140),
      actor: ctx.alias,
    });
  }
  return json(c, { status: 201 });
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
  if (existing.author !== ctx.alias && !manages(ctx, doc)) {
    return error(403, "only the comment author or doc owner can resolve this comment");
  }
  const updated = await setCommentResolved(ctx.sql, docId, num, body.resolved);
  if (!updated) return error(404, "comment not found");
  return json(updated);
}

export async function deleteDocComment({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const num = Number(match[2]);
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  const existing = await getComment(ctx.sql, docId, num);
  if (!existing) return error(404, "comment not found");
  if (existing.author !== ctx.alias && !manages(ctx, doc)) {
    return error(403, "only the comment author or doc owner can delete this comment");
  }
  const deleted = await deleteComment(ctx.sql, docId, num);
  return deleted ? json({ deleted: true }) : error(404, "comment not found");
}
