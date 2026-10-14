/**
 * Who hears of a new comment, and why: the people it mentions, the people in the thread it replies
 * in, and the document's owner. Each person hears once, for the most specific reason, and only if
 * they can read the document; never the writer, nor the person whose co-author wrote it, who is
 * watching it. An agent's person hears as anyone does, and of replies to their agent as if to
 * themselves: an agent often works while they are away.
 */
import { principalId } from "@stuga/auth";
import { IMPORTED_AUTHOR_PREFIX, type CommentRow, type DocRow, type Sql } from "@stuga/db";
import type { CommentReplyRelation } from "@stuga/protocol/notify/events";
import { canOpenDoc, mentionReaders } from "../mentions/recipients.js";
import { commentAgents } from "./read.js";

/** A person's AI co-author writes as `panel:<their alias>`. */
export const COAUTHOR_PREFIX = "panel:";

/** One notice a comment sends, before it is worded. */
export type CommentNotice =
  | { reason: "mention"; recipient: string }
  | { reason: "reply"; recipient: string; relation: CommentReplyRelation }
  | { reason: "owner"; recipient: string };

/** The thread a reply lands in: its root, and the replies before this one. */
export interface ThreadSoFar {
  root: CommentRow;
  earlier: readonly CommentRow[];
}

/**
 * The person a comment's author stands for, as a notice reaches them: `panel:X` is X's co-author,
 * and an agent stands for the person it works for (`agents`, from its key or grant). Sample agent,
 * an agent whose person is gone, an archive's name and a restore are no one to notify.
 */
export function authorPerson(author: string, agents: Readonly<Record<string, string | null>>): string | null {
  if (author.startsWith(COAUTHOR_PREFIX)) return author.slice(COAUTHOR_PREFIX.length);
  if (author.startsWith("agent-")) return agents[author] ?? null;
  if (author.startsWith(IMPORTED_AUTHOR_PREFIX) || author.startsWith("restore:")) return null;
  return author;
}

/**
 * Every notice a comment sends, mentions first, then replies, then the owner's, each person at most
 * once. `author` is who wrote it, and `self` who hears nothing of it: the writer, or for a co-author its
 * person. `mentioned` are the aliases the
 * comment resolved; `thread` is null for a new thread; `owner` says whether the writer's comments
 * reach the owner at all.
 */
export async function commentNotices(
  sql: Sql,
  doc: Pick<DocRow, "workspace_id" | "acl_principals" | "owner">,
  c: { author: string; self: string; mentioned: readonly string[]; thread: ThreadSoFar | null; owner: boolean },
): Promise<CommentNotice[]> {
  // An agent's @mention of its own person is a ping it means to send, as Sample agent's is.
  const mentioned = await mentionReaders(sql, doc, c.mentioned, c.author);
  const notices: CommentNotice[] = mentioned.map((recipient) => ({ reason: "mention", recipient }));
  const told = new Set([c.self, ...notices.map((n) => n.recipient)]);
  if (c.thread) {
    for (const reply of await threadReaders(sql, doc, c.thread, told)) {
      notices.push({ reason: "reply", ...reply });
      told.add(reply.recipient);
    }
  }
  const owner = doc.owner.startsWith("user:") ? principalId(doc.owner) : null;
  // An owner who has left the workspace still owns the row, not the document: they hear nothing of it.
  if (c.owner && owner && !told.has(owner) && (await canOpenDoc(sql, doc, owner))) notices.push({ reason: "owner", recipient: owner });
  return notices;
}

/**
 * The people a reply reaches through its thread, in thread order: the root's author, for their
 * comment, their co-author's question or their agent's comment, then each earlier replier, for a
 * thread they or their co-author or agent wrote in.
 */
async function threadReaders(
  sql: Sql,
  doc: Pick<DocRow, "workspace_id" | "acl_principals">,
  thread: ThreadSoFar,
  skip: ReadonlySet<string>,
): Promise<Array<{ recipient: string; relation: CommentReplyRelation }>> {
  const out: Array<{ recipient: string; relation: CommentReplyRelation }> = [];
  const seen = new Set(skip);
  const comments = [thread.root, ...thread.earlier];
  const agents = await commentAgents(sql, comments);
  for (const c of comments) {
    const person = authorPerson(c.author, agents);
    if (person === null || seen.has(person)) continue;
    seen.add(person);
    // Being in a thread grants nothing: someone who lost the document since hears nothing of it.
    if (!(await canOpenDoc(sql, doc, person))) continue;
    out.push({ recipient: person, relation: c === thread.root ? rootRelation(c.author, person) : "thread" });
  }
  return out;
}

/** Why a reply reaches the person its thread's first comment stands for. */
function rootRelation(author: string, person: string): CommentReplyRelation {
  if (author === person) return "comment";
  return author.startsWith(COAUTHOR_PREFIX) ? "coauthor_question" : "agent_comment";
}
