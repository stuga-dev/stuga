/**
 * A thread turn: the co-author answering a person's reply in a comment thread. What the model is
 * shown of the thread, labelled by identity; the answer it posts there; and the outcome kept per
 * reply, so a retried reply is answered once.
 */
import type { ThreadContext, ThreadRole } from "@stuga/ai";
import { stripCitationMarkers } from "@stuga/protocol/text/citation-markers";
import type { AiEditsPayload, ThreadScope } from "@stuga/protocol/wire/doc-socket";
import type { ActorStorage } from "@stuga/runtime";
import type { CommentThread, ThreadMessage } from "./cross-doc.js";
import { MAX_AI_PROMPT_CHARS } from "./inputs.js";

/** Replies before the one answered that the model sees; the root is always shown. */
export const THREAD_CONTEXT_REPLIES = 10;
/** Characters of each thread message the model sees. */
export const THREAD_MESSAGE_CHARS = 1_000;
/** Characters of the answer posted in the thread; the full prose stays in the panel. */
export const THREAD_REPLY_CHARS = 2_000;
/** Reply outcomes kept per person. */
export const THREAD_OUTCOMES_MAX = 200;

/** `text` cut to `max` characters with an ellipsis, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Who wrote a message, from its author id alone, relative to `person`: a display name is
 * anyone's to choose, an id is not.
 */
export function threadRole(author: string, person: string): ThreadRole {
  if (author === `panel:${person}`) return "you";
  if (author === person) return "requester";
  if (author.startsWith("panel:")) return "other_coauthor";
  if (author.startsWith("agent-")) return "agent";
  if (author.startsWith("imported:")) return "imported";
  return "person";
}

/** The thread turn a request names: the reply it answers, and the thread as the model sees it. */
export interface ThreadTurn {
  scope: ThreadScope;
  reply: ThreadMessage;
  /** The turn's request: the reply's own text. */
  prompt: string;
  context: ThreadContext;
  /** The root's `created_at`, which the answer is posted against: a deleted root's number can come back on another thread. */
  rootCreatedAt: string;
  /** The outcome's key: `created_at` tells a reply from a later one that took its freed number. */
  key: string;
}

/**
 * The turn `scope` asks for, or null when its reply is not `person`'s own reply in this thread.
 * The model sees the root, the replies just before the one answered, and its own answers posted
 * after it by a turn that ran first; that reply is the request.
 */
export function threadTurn(thread: CommentThread, scope: ThreadScope, person: string): ThreadTurn | null {
  const root = thread.messages.find((m) => m.num === scope.num && m.parent_num === null);
  if (!root) return null;
  const replies = thread.messages.filter((m) => m.parent_num === scope.num).sort((a, b) => a.num - b.num);
  const reply = replies.find((m) => m.num === scope.reply_num);
  if (!reply || reply.author !== person) return null;
  const before = replies.filter((m) => m.num < reply.num);
  const kept = before.slice(-THREAD_CONTEXT_REPLIES);
  // Its own answers to later replies, from turns that ran first, so this answer follows on from them.
  const ownLater = replies.filter((m) => m.num > reply.num && m.author === `panel:${person}`);
  const shown = (m: ThreadMessage) => ({ role: threadRole(m.author, person), text: clip(m.body, THREAD_MESSAGE_CHARS) });
  // Anyone who can comment sets the quote, unchecked, so it is bounded like a message.
  const quote = thread.anchor_quote === null ? null : clip(thread.anchor_quote, THREAD_MESSAGE_CHARS);
  return {
    scope,
    reply,
    prompt: reply.body.slice(0, MAX_AI_PROMPT_CHARS),
    context: { quote, messages: [root, ...kept, ...ownLater].map(shown), omitted: before.length - kept.length },
    rootCreatedAt: root.created_at,
    key: `${scope.num}:${reply.num}:${reply.created_at}`,
  };
}

/** The answer as the thread shows it: plain text, without the source markers the panel renders. */
export function threadReplyText(prose: string): string {
  return clip(stripCitationMarkers(prose), THREAD_REPLY_CHARS);
}

/** One answered reply under `coauthor-threads:<alias>`: the AI_EDITS the turn sent. */
export interface StoredThreadOutcome {
  key: string;
  edits: AiEditsPayload;
}

function threadOutcomesKey(alias: string): string {
  return `coauthor-threads:${alias}`;
}

/** The outcome of each reply a person's co-author answered, newest last, in actor storage. */
export class ThreadOutcomes {
  constructor(private readonly storage: ActorStorage) {}

  async get(alias: string, key: string): Promise<AiEditsPayload | null> {
    const list = (await this.storage.get<StoredThreadOutcome[]>(threadOutcomesKey(alias))) ?? [];
    return list.find((o) => o.key === key)?.edits ?? null;
  }

  /** Never fails the turn: a lost record costs only a retry's second answer. */
  async record(alias: string, key: string, edits: AiEditsPayload): Promise<void> {
    try {
      const list = (await this.storage.get<StoredThreadOutcome[]>(threadOutcomesKey(alias))) ?? [];
      const next = [...list.filter((o) => o.key !== key), { key, edits }].slice(-THREAD_OUTCOMES_MAX);
      await this.storage.put(threadOutcomesKey(alias), next);
    } catch (e) {
      console.warn("co-author thread outcome not recorded", { key, err: String(e) });
    }
  }
}
