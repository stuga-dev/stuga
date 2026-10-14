/**
 * The co-author's comments: the thread a reply turn answers, the questions and replies it posts
 * as `panel:<person>`, and the notice for questions its person was not there to see. The caller
 * is the document's own actor, holding the lock its turn runs under, so nothing here fetches
 * that actor: it tells its own pages.
 */
import { getDoc, getUserDisplayName, listComments, type DocRow } from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import { canCommentDoc, canReadDoc, canWriteDoc } from "../authz/authz.js";
import { commentInput, isCommentRefusal, postComment } from "../comments/post.js";
import type { NodeEnv } from "../env.js";
import { json } from "../http/respond.js";
import { canOpenDoc } from "../mentions/recipients.js";
import { panelCtx } from "./panel.js";

/** A turn asks at most three questions; this only bounds what one call can fan out. */
const MAX_ASKED = 10;

/** What every call here names: the person, their session's principals, and the open document. */
interface PanelDocBody {
  workspaceId?: unknown;
  principals?: unknown;
  alias?: unknown;
  doc_id?: unknown;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function isCommentNum(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The person's co-author and the document it works on, when the person may read it; else the refusal. */
async function panelDoc(env: NodeEnv, body: PanelDocBody): Promise<{ ctx: Ctx; person: string; doc: DocRow } | Response> {
  const ctx = panelCtx(env, body);
  const docId = typeof body.doc_id === "string" ? body.doc_id : "";
  if (!ctx || !docId) return json({ error: "bad request" }, { status: 400 });
  const doc = await getDoc(env.sql, docId);
  // Co-author turns run on prose; a database id must not pass for one.
  if (!doc || doc.trashed || doc.doc_type !== "prose" || !canReadDoc(ctx, doc)) return json({ error: "not found" }, { status: 404 });
  return { ctx, person: ctx.onBehalfOf ?? "", doc };
}

/**
 * A thread as a reply turn reads it: the root, then its replies by number, with raw author ids
 * for the actor to label by role, and whether the person may write now.
 */
export async function handleInternalCommentThread(req: Request, env: NodeEnv): Promise<Response> {
  const body = await readBody(req);
  if (!isCommentNum(body.num)) return json({ error: "bad request" }, { status: 400 });
  const at = await panelDoc(env, body);
  if (at instanceof Response) return at;
  const rows = await listComments(env.sql, at.doc.doc_id);
  const root = rows.find((c) => c.num === body.num && c.parent_num === null);
  if (!root) return json({ error: "comment not found" }, { status: 404 });
  const thread = [root, ...rows.filter((c) => c.parent_num === root.num)];
  return json({
    // A socket's write tier can be stale behind a long turn; this one is read now.
    can_write: canWriteDoc(at.ctx, at.doc),
    resolved: root.resolved,
    anchor_quote: root.anchor_quote,
    messages: thread.map((c) => ({
      num: c.num,
      parent_num: c.parent_num,
      author: c.author,
      body: c.body,
      created_at: new Date(c.created_at).toISOString(),
    })),
  });
}

/**
 * A question or reply the co-author posts as `panel:<person>`. It resolves no @mentions, and does
 * not tell the document's pages: its actor does that itself. A question notifies no one; an answer
 * in a thread notifies the thread's people, as a person's reply does.
 */
export async function handleInternalComment(req: Request, env: NodeEnv): Promise<Response> {
  const body = await readBody(req);
  const input = commentInput(body);
  if (typeof input === "string") return json({ error: input }, { status: 400 });
  const parentCreatedAt = typeof body.parent_created_at === "string" ? body.parent_created_at : null;
  if (input.parentNum !== null && parentCreatedAt === null) return json({ error: "parent_created_at required" }, { status: 400 });
  const at = await panelDoc(env, body);
  if (at instanceof Response) return at;
  const { ctx, doc } = at;
  if (!canCommentDoc(ctx, doc)) return json({ error: "no comment access" }, { status: 403 });
  // The thread must still be open, and the one the turn read: its root is named by number and `created_at`.
  const out = await postComment(ctx, doc, { ...input, ...(parentCreatedAt !== null ? { parentCreatedAt } : {}) });
  if (isCommentRefusal(out)) return json({ error: out.error }, { status: out.status });
  return json(out.comment, { status: 201 });
}

/**
 * Notify a person of the questions their co-author asked while they had no page open on the
 * document. Each must still be an open question of theirs, and they must still be able to read
 * the document, which the notify worker does not check.
 */
export async function handleInternalCoauthorAsked(req: Request, env: NodeEnv): Promise<Response> {
  const body = await readBody(req);
  const nums = Array.isArray(body.nums) ? [...new Set(body.nums.filter(isCommentNum))].slice(0, MAX_ASKED) : [];
  if (nums.length === 0) return json({ error: "bad request" }, { status: 400 });
  const at = await panelDoc(env, body);
  if (at instanceof Response) return at;
  const { ctx, person, doc } = at;
  // Live membership, not the session's principals: the person may have left since the turn began.
  if (!(await canOpenDoc(env.sql, doc, person))) return new Response(null, { status: 204 });
  const comments = new Map((await listComments(env.sql, doc.doc_id)).map((c) => [c.num, c]));
  // Named in the reader's language, as every co-author notice is.
  const actor = { coauthor_of: (await getUserDisplayName(env.sql, person)) || person };
  for (const num of nums) {
    const question = comments.get(num);
    if (!question || question.parent_num !== null || question.resolved || question.author !== ctx.alias) continue;
    await env.jobs.send({
      kind: "notify",
      recipient: person,
      workspaceId: ctx.workspaceId,
      docId: doc.doc_id,
      commentNum: num,
      actor: ctx.alias,
      eventType: "MENTIONED_IN_COMMENT",
      params: { actor, doc: doc.title, excerpt: question.body.slice(0, 140) },
    });
  }
  return new Response(null, { status: 204 });
}
