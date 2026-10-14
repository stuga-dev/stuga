/**
 * Posting a comment, the one way every surface does it: a person from the app or REST, an agent
 * over MCP or REST, and a person's AI co-author from inside its turn. Who writes decides what the
 * comment may mention, who hears of it, and whether the document's open pages are told from here.
 */
import { COMMENT_MAX_AGENT_MENTIONS } from "@stuga/agent-surface/catalog";
import type { QuoteAnchor } from "@stuga/crdt-ops";
import { addComment, getComment, getMembersByUsername, getUserDisplayName, listComments, type CommentRow, type DocRow } from "@stuga/db";
import { MAX_MENTIONS, commentMentionCandidates } from "@stuga/protocol/domain/mentions";
import { SAMPLE_AGENT_ALIAS, SAMPLE_AGENT_NAME } from "@stuga/protocol/domain/workspaces";
import type { NotifyMessage } from "@stuga/protocol/internal/jobs";
import { notification, type ActorParam } from "@stuga/protocol/notify/events";
import { recordEvent } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { personOf } from "../authz/authz.js";
import { pushCommentsChanged } from "../documents/access.js";
import { agentBudgetKey, agentNoticeBudget } from "./budget.js";
import { COAUTHOR_PREFIX, commentNotices, type CommentNotice, type ThreadSoFar } from "./recipients.js";

/** Who is writing: a person, an agent on a key or connector, or a person's AI co-author. */
export type CommentCaller = "person" | "agent" | "coauthor";

export function commentCaller(ctx: Ctx): CommentCaller {
  if (!ctx.isAgent) return "person";
  return ctx.alias.startsWith(COAUTHOR_PREFIX) ? "coauthor" : "agent";
}

/** What each kind of writer's comment does beyond being saved. */
interface CallerPolicy {
  /** How many people it may mention, and what more does; null resolves no @mentions at all. */
  mentions: { max: number; over: "drop" | "refuse" } | null;
  /** Whether the owner hears of it. */
  ownerNotice: boolean;
  /** Whether its notices come out of its person's agent allowance (budget.ts). */
  budgeted: boolean;
  /** Whether this posting tells the document's open pages; the co-author's actor tells its own. */
  tellsPages: boolean;
  /**
   * How it places a new thread on a passage: by positions it found in the text itself (the editor,
   * the co-author's actor), or only by text it quotes, which the document's actor finds.
   */
  places: "positions" | "quote";
}

const POLICIES: Record<CommentCaller, CallerPolicy> = {
  person: { mentions: { max: MAX_MENTIONS, over: "drop" }, ownerNotice: true, budgeted: false, tellsPages: true, places: "positions" },
  agent: { mentions: { max: COMMENT_MAX_AGENT_MENTIONS, over: "refuse" }, ownerNotice: true, budgeted: true, tellsPages: true, places: "quote" },
  // Its question is the person's own business until someone answers; its answer reaches the thread.
  coauthor: { mentions: null, ownerNotice: false, budgeted: false, tellsPages: false, places: "positions" },
};

/** A new comment as a request states it, before its parent is looked up. */
export interface CommentInput {
  body: string;
  parentNum: number | null;
  anchorStart: string | null;
  anchorEnd: string | null;
  anchorQuote: string | null;
  /** Text of the document to anchor a new thread on, found by its actor: there exactly once, as written. */
  quote?: string;
}

/** A new comment's fields held to the limits every surface shares; a string is the refusal. */
export function commentInput(raw: {
  body?: unknown;
  parent_num?: unknown;
  anchor_start?: unknown;
  anchor_end?: unknown;
  anchor_quote?: unknown;
  quote?: unknown;
}): CommentInput | string {
  if (typeof raw.body !== "string" || !raw.body.trim()) return "comment body required";
  const body = raw.body.trim();
  const anchorStart = typeof raw.anchor_start === "string" ? raw.anchor_start : null;
  const anchorEnd = typeof raw.anchor_end === "string" ? raw.anchor_end : null;
  const anchorQuote = typeof raw.anchor_quote === "string" ? raw.anchor_quote : null;
  if (body.length > 20_000) return "comment too long";
  if ((anchorQuote ?? "").length > 2_000) return "anchor quote too long";
  if ((anchorStart ?? "").length > 1_000 || (anchorEnd ?? "").length > 1_000) return "anchor too long";
  let parentNum: number | null = null;
  if (raw.parent_num !== undefined && raw.parent_num !== null) {
    if (typeof raw.parent_num !== "number" || !Number.isSafeInteger(raw.parent_num) || raw.parent_num < 0) return "invalid parent_num";
    parentNum = raw.parent_num;
  }
  const input: CommentInput = { body, parentNum, anchorStart, anchorEnd, anchorQuote };
  if (raw.quote === undefined || raw.quote === null) return input;
  if (typeof raw.quote !== "string" || !raw.quote) return "invalid quote";
  if (raw.quote.length > 2_000) return "quote too long";
  return { ...input, quote: raw.quote };
}

/** What a caller asks to post. */
export interface CommentRequest extends CommentInput {
  /**
   * The root's `created_at` as the caller read it: the reply must land in that thread, still open
   * and still a root. A deleted root's number comes back on a later comment, so it is named by both.
   */
  parentCreatedAt?: string;
}

export interface PostedComment {
  comment: CommentRow;
  /** Notices withheld because the writer's person's agents used up their hour's allowance. */
  suppressed: number;
}

export interface CommentRefusal {
  status: number;
  error: string;
}

export function isCommentRefusal(out: PostedComment | CommentRefusal): out is CommentRefusal {
  return "error" in out;
}

/** How long a quote waits for the document's actor, whose lock a co-author turn holds until the turn ends. */
export const QUOTE_ANCHOR_WAIT_MS = 15_000;

export const QUOTE_NOT_ONCE = "quote must appear exactly once in the document's text, as written";
export const DOCUMENT_BUSY = "the document is busy; try again shortly";
export const AGENT_PLACES_BY_QUOTE = "an agent attaches a comment to a passage with `quote`";

/**
 * Documents with a quote lookup still queued at their actor. A caller that gave up cannot withdraw
 * it, so each retry would queue one more lookup to run, unread, once the turn ends.
 */
const quoteAnchorPending = new Set<string>();

/**
 * Save a comment and tell whoever should hear of it. The caller has checked that `ctx` may comment
 * on `doc`; this holds the comment to what its writer may do. Nothing is saved when it is refused.
 */
export async function postComment(ctx: Ctx, doc: DocRow, asked: CommentRequest): Promise<PostedComment | CommentRefusal> {
  const caller = commentCaller(ctx);
  const policy = POLICIES[caller];
  const req = placement(asked, policy);
  if ("error" in req) return req;
  if (req.quote !== undefined && req.parentNum !== null) {
    return { status: 400, error: "a reply shares its thread's passage: pass `quote` or `parent_num`, not both" };
  }
  const root = await rootOf(ctx, doc, req);
  if (root && "error" in root) return root;
  const mentions = await mentionsIn(ctx, req.body, policy);
  if ("error" in mentions) return mentions;
  const anchor = req.quote === undefined ? { start: req.anchorStart, end: req.anchorEnd, quote: req.anchorQuote } : await anchorOfQuote(ctx, doc, req.quote);
  if ("error" in anchor) return anchor;

  const parentNum = root?.num ?? null;
  const comment = await addComment(ctx.sql, {
    docId: doc.doc_id,
    author: ctx.alias,
    body: req.body,
    parentNum,
    // addComment drops the anchor of a reply, which inherits its thread's.
    anchorStart: anchor.start,
    anchorEnd: anchor.end,
    anchorQuote: anchor.quote,
    mentions,
  });
  // Stamped with the comment's own time: the feed matches a reply to its root by when each was written.
  recordEvent(ctx, "comment.added", doc.doc_id, { num: comment.num, parent_num: parentNum, excerpt: req.body.slice(0, 140) }, comment.created_at);
  // Not awaited: the actor answers under its lock, which a co-author turn holds until it ends.
  if (policy.tellsPages) void pushCommentsChanged(ctx.env, doc.doc_id, doc.doc_type);

  const thread = root ? await threadSoFar(ctx, doc, root, comment.num) : null;
  const notices = await commentNotices(ctx.sql, doc, {
    author: ctx.alias,
    // The co-author runs only while its person watches it; an agent often works while they are away.
    self: caller === "coauthor" ? personOf(ctx) : ctx.alias,
    mentioned: mentions.map((m) => m.alias),
    thread,
    owner: policy.ownerNotice,
  });
  // Reserved before anything is queued, so two comments racing cannot both spend the last of it.
  const granted = policy.budgeted ? agentNoticeBudget.reserve(agentBudgetKey(ctx.workspaceId, personOf(ctx)), notices.length) : notices.length;
  if (granted > 0) {
    const words = { actor: await actorParam(ctx, caller), doc: doc.title, excerpt: req.body.slice(0, 140) };
    const about = { workspaceId: ctx.workspaceId, docId: doc.doc_id, commentNum: comment.num, actor: ctx.alias };
    // A reply's notices in one thread within the hour are one; the root's creation time keeps a later
    // thread that reused its number apart.
    const threadKey = root ? `${root.num}@${new Date(root.created_at).getTime()}` : undefined;
    for (const notice of notices.slice(0, granted)) await ctx.env.jobs.send(noticeMessage(notice, about, words, threadKey));
  }
  return { comment, suppressed: notices.length - granted };
}

/**
 * The request as its writer may place it. Positions an agent sends would pin its comment wherever
 * they point, under whatever quote it states, so an agent names its passage only by quoting it.
 */
function placement(req: CommentRequest, policy: CallerPolicy): CommentRequest | CommentRefusal {
  if (policy.places === "positions") return req;
  if (req.anchorStart !== null || req.anchorEnd !== null) return { status: 400, error: AGENT_PLACES_BY_QUOTE };
  // REST named the passage `anchor_quote` before `quote`; an agent's is found as strictly. Empty quotes nothing.
  const quote = req.quote ?? (req.anchorQuote || undefined);
  return { ...req, anchorQuote: null, ...(quote !== undefined ? { quote } : {}) };
}

/** The root a reply lands under, null for a new thread, or the refusal when there is none to reply in. */
async function rootOf(ctx: Ctx, doc: DocRow, req: CommentRequest): Promise<CommentRow | CommentRefusal | null> {
  if (req.parentNum === null) return null;
  const parent = await getComment(ctx.sql, doc.doc_id, req.parentNum);
  if (req.parentCreatedAt !== undefined) {
    const open = parent && parent.parent_num === null && !parent.resolved && new Date(parent.created_at).toISOString() === req.parentCreatedAt;
    return open ? parent : { status: 409, error: "thread closed" };
  }
  if (!parent) return { status: 400, error: "parent comment not found" };
  // Threads are one level deep: a reply to a reply attaches to the thread head.
  if (parent.parent_num === null) return parent;
  return (await getComment(ctx.sql, doc.doc_id, parent.parent_num)) ?? { status: 400, error: "parent comment not found" };
}

/** The members a comment's @usernames name, in the order written, as far as its writer may mention. */
async function mentionsIn(ctx: Ctx, body: string, policy: CallerPolicy): Promise<CommentRow["mentions"] | CommentRefusal> {
  if (!policy.mentions) return [];
  const candidates = commentMentionCandidates(body);
  const members = new Map((await getMembersByUsername(ctx.sql, candidates, ctx.workspaceId)).map((m) => [m.username, m]));
  const mentions = candidates.flatMap((u) => members.get(u) ?? []);
  const { max, over } = policy.mentions;
  if (mentions.length <= max) return mentions;
  // An agent's mentions are a ping it sends people, so more than its share is refused rather than quietly cut.
  if (over === "refuse") return { status: 400, error: `an agent's comment may mention at most ${max} people` };
  return mentions.slice(0, max);
}

/**
 * Where `quote` sits in the document, from its actor: only text there exactly once, exactly as
 * written, pinned to both ends, so the comment lands where its writer meant and stays there.
 */
async function anchorOfQuote(ctx: Ctx, doc: DocRow, quote: string): Promise<QuoteAnchor | CommentRefusal> {
  if (doc.doc_type !== "prose") return { status: 400, error: "`quote` anchors to a document's text; a database has none" };
  // While one waits, the actor's lock is still held, so the next would wait too.
  if (quoteAnchorPending.has(doc.doc_id)) return { status: 503, error: DOCUMENT_BUSY };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const busy = new Promise<"busy">((resolve) => {
    timer = setTimeout(() => resolve("busy"), QUOTE_ANCHOR_WAIT_MS);
  });
  try {
    const res = await Promise.race([askQuoteAnchor(ctx, doc.doc_id, quote), busy]);
    if (res === "busy") return { status: 503, error: DOCUMENT_BUSY };
    const body = (await res.json().catch(() => null)) as { anchor?: QuoteAnchor | null } | null;
    if (!res.ok || !body) return { status: 502, error: "could not read the document; try again" };
    const anchor = body.anchor;
    if (!anchor || anchor.quote !== quote || !anchor.start || !anchor.end) return { status: 400, error: QUOTE_NOT_ONCE };
    return anchor;
  } catch {
    return { status: 502, error: "could not read the document; try again" };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the document's actor where `quote` sits; the document stays pending until the actor answers. */
function askQuoteAnchor(ctx: Ctx, docId: string, quote: string): Promise<Response> {
  quoteAnchorPending.add(docId);
  // Async, so a throw on the way out settles it too and clears the mark.
  const asked = (async () =>
    ctx.env.docs.get(docId).fetch(`http://actor/quote-anchor?docId=${encodeURIComponent(docId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote }),
    }))();
  void asked.catch(() => undefined).finally(() => quoteAnchorPending.delete(docId));
  return asked;
}

/** The thread so far: its root, and the replies before `num`. */
async function threadSoFar(ctx: Ctx, doc: DocRow, root: CommentRow, num: number): Promise<ThreadSoFar> {
  const rows = await listComments(ctx.sql, doc.doc_id);
  return { root, earlier: rows.filter((c) => c.parent_num === root.num && c.num < num) };
}

/**
 * The writer as a notice names them: a person by their own name, an agent or a co-author by the
 * name of the person it acts for, read from the directory, never a name the agent's client chose.
 */
async function actorParam(ctx: Ctx, caller: CommentCaller): Promise<ActorParam> {
  if (caller === "person") return ctx.displayName || ctx.alias;
  // The node's own name for it, as the comment and review show it, not its importer's agent.
  if (ctx.alias === SAMPLE_AGENT_ALIAS) return SAMPLE_AGENT_NAME;
  const person = personOf(ctx);
  const name = (await getUserDisplayName(ctx.sql, person)) || person;
  return caller === "agent" ? { agent_of: name } : { coauthor_of: name };
}

/** One notice as the notify worker takes it; `thread` is the reply's thread, unset for a new one. */
function noticeMessage(
  notice: CommentNotice,
  about: { workspaceId: string; docId: string; commentNum: number; actor: string },
  words: { actor: ActorParam; doc: string; excerpt: string },
  thread: string | undefined,
): NotifyMessage {
  const to = { kind: "notify", recipient: notice.recipient, ...about } as const;
  switch (notice.reason) {
    case "mention":
      return { ...to, ...notification("MENTIONED_IN_COMMENT", words) };
    case "owner":
      return { ...to, ...notification("COMMENT_ON_OWNED_DOC", { ...words, kind: thread === undefined ? "comment" : "reply" }) };
    case "reply":
      return { ...to, ...notification("COMMENT_REPLY", { ...words, relation: notice.relation }), thread };
  }
}
