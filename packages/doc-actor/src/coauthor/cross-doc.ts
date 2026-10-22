/**
 * The co-author's calls back into the node. The actor holds no database, so
 * reads, search, media ingest, comments and proposals into other documents go
 * through the internal API carrying the session's principals, and the node
 * enforces the ACL. Every call degrades rather than failing the turn, except the
 * read of the thread a thread turn answers, which is its request.
 *
 * None of these calls may reach this actor: a turn holds its lock throughout.
 */
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { parseInstructionLevels, type InstructionLevel } from "@stuga/protocol/domain/instructions";
import { parseReviewMode } from "@stuga/protocol/domain/runs";
import type { CoauthorNotice, CrossDocError } from "@stuga/protocol/api/ai-turn";
import type { AiCitation, AiCrossDocProposal, AiStrEdit } from "@stuga/protocol/wire/doc-socket";
import { CITATION_EXCERPT_CHARS } from "@stuga/protocol/wire/doc-socket";
import type { ToolRunner } from "@stuga/ai";
import type { InternalApi } from "@stuga/runtime";
import type { SessionMeta } from "../session.js";

function post(internal: InternalApi, path: string, body: unknown): Promise<Response> {
  return internal.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The instructions for agents that apply to this document for the session's
 * principals, outermost first. House style, not a security control: a failed
 * read runs the turn without them rather than refusing to answer.
 */
export async function fetchInstructionStack(internal: InternalApi, docId: string, meta: SessionMeta): Promise<InstructionLevel[]> {
  try {
    const res = await post(internal, "/internal/agent-instructions", {
      workspaceId: meta.workspaceId,
      docId,
      principals: meta.principals,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { levels?: unknown } | null;
    return parseInstructionLevels(data?.levels);
  } catch (e) {
    console.warn("instructions for agents unavailable for this turn", { docId, err: String(e) });
    return [];
  }
}

/** How this turn's edits to a document are reviewed, as the node resolved it, and the title its notices name. */
export interface TurnReview {
  mode: ReviewMode;
  /** At `colleague`, the approver group the document's folders name. */
  approverGroup: string | null;
  title: string;
}

/**
 * Whether this turn's edits to the document wait for review or apply at once,
 * per the document's level. Unknown means `review`: a failed read never
 * becomes a silent commit.
 */
export async function fetchReviewMode(internal: InternalApi, docId: string, meta: SessionMeta): Promise<TurnReview> {
  const unknown: TurnReview = { mode: "review", approverGroup: null, title: "" };
  try {
    const res = await post(internal, "/internal/review-mode", { workspaceId: meta.workspaceId, docId, principals: meta.principals });
    if (!res.ok) return unknown;
    const data = (await res.json()) as { mode?: unknown; approver_group?: unknown; title?: unknown } | null;
    return {
      mode: parseReviewMode(data?.mode),
      approverGroup: typeof data?.approver_group === "string" && data.approver_group ? data.approver_group : null,
      title: typeof data?.title === "string" ? data.title : "",
    };
  } catch (e) {
    console.warn("review mode unavailable for this turn; its edits wait for review", { docId, err: String(e) });
    return unknown;
  }
}

/**
 * The cross-document tools of one turn. A selected collection bounds every one
 * of them, and the node enforces it; a refusal's `message` is worded for the
 * model. `citations` collects every search result in push order.
 */
export function crossDocTools(
  internal: InternalApi,
  docId: string,
  meta: SessionMeta,
  collectionId: string | null,
  citations: AiCitation[],
): Pick<ToolRunner, "listDocuments" | "openDocument" | "searchCollection"> {
  // Titles from list_documents label documents whose read does not echo one.
  const docTitles = new Map<string, string>();
  return {
    listDocuments: async () => {
      try {
        const res = await post(internal, "/internal/editable-docs", {
          principals: meta.principals,
          workspaceId: meta.workspaceId,
          alias: meta.alias,
          collection_id: collectionId,
          exclude: docId,
        });
        const data = (await res.json()) as { docs?: Array<{ doc_id: string; title: string }> };
        const docs = data.docs ?? [];
        for (const d of docs) docTitles.set(d.doc_id, d.title);
        return docs;
      } catch {
        return [];
      }
    },
    openDocument: async (target) => {
      try {
        const res = await post(internal, "/internal/doc-markdown", {
          doc_id: target,
          principals: meta.principals,
          workspaceId: meta.workspaceId,
          alias: meta.alias,
          collection_id: collectionId,
        });
        const data = (await res.json().catch(() => null)) as {
          markdown?: string;
          title?: string;
          message?: string;
          instructions?: unknown;
        } | null;
        if (!res.ok) return typeof data?.message === "string" ? { error: data.message } : null;
        if (!data || typeof data.markdown !== "string") return null;
        return {
          docId: target,
          title: data.title ?? docTitles.get(target) ?? target,
          markdown: data.markdown,
          instructions: parseInstructionLevels(data.instructions),
        };
      } catch {
        return null;
      }
    },
    searchCollection: async ({ query }) => {
      if (!collectionId) return { text: "Cross-document search is unavailable for this session.", citations: [] };
      try {
        const res = await post(internal, "/internal/retrieve", {
          query,
          collection_id: collectionId,
          principals: meta.principals,
          scopeFolderIds: meta.scopeFolderIds,
          workspaceId: meta.workspaceId,
          alias: meta.alias,
        });
        const data = (await res.json()) as {
          chunks?: Array<{ doc_id: string; title: string; heading_path?: string | null; content: string }>;
          message?: string;
        };
        if (typeof data.message === "string") return { text: `Search failed: ${data.message}.`, citations: [] };
        const chunks = data.chunks ?? [];
        if (chunks.length === 0) return { text: "No relevant passages found in the collection.", citations: [] };
        // Numbered from the running total, so the [n] the model reads equals the
        // citation's final number across several searches in one turn.
        const offset = citations.length;
        const found: AiCitation[] = chunks.map((c, i) => ({
          n: offset + i + 1,
          doc_id: c.doc_id,
          title: c.title,
          heading_path: c.heading_path ?? null,
          content: (c.content ?? "").slice(0, CITATION_EXCERPT_CHARS),
        }));
        citations.push(...found);
        const text = chunks
          .map((c, i) => `[${offset + i + 1}] ${c.title}${c.heading_path ? ` — ${c.heading_path}` : ""}\n${c.content}`)
          .join("\n\n");
        return { text, citations: found };
      } catch (e) {
        return { text: `Search failed: ${e instanceof Error ? e.message : String(e)}`, citations: [] };
      }
    },
  };
}

/**
 * Host external images a turn's edits reference, rewriting the edits in place, so
 * the destination the reviewer sees is the one that lands. Returns what the reviewer should
 * know about images left external — an image that could not be fetched never costs the turn.
 */
export async function hostAgentImages(internal: InternalApi, docId: string, edits: AiStrEdit[], meta: SessionMeta): Promise<CoauthorNotice[]> {
  const targets = edits.filter((e) => e.new_string.includes("!["));
  if (targets.length === 0) return [];
  try {
    const res = await post(internal, "/internal/media-ingest", {
      doc_id: docId,
      principals: meta.principals,
      workspaceId: meta.workspaceId,
      markdown: targets.map((e) => e.new_string),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      markdown?: string[];
      failures?: Array<{ url?: unknown; reason?: unknown }>;
      truncated_after?: number | null;
    };
    // Paired by index, so an answer of the wrong length is dropped rather than misapplied.
    if (!Array.isArray(data.markdown) || data.markdown.length !== targets.length) return [];
    targets.forEach((e, i) => {
      e.new_string = data.markdown![i]!;
    });
    const notices: CoauthorNotice[] = (Array.isArray(data.failures) ? data.failures : [])
      .filter((f) => typeof f?.url === "string" && typeof f.reason === "string")
      .map((f) => ({ code: "image_not_downloaded", url: f.url as string, reason: f.reason as string }));
    if (typeof data.truncated_after === "number") notices.push({ code: "images_truncated", count: data.truncated_after });
    return notices;
  } catch {
    return [];
  }
}

/**
 * Why the node refused a proposal, from its status: its sentence is written for
 * agents, and the person reads the app's own words.
 */
function crossDocError(status: number): CrossDocError {
  switch (status) {
    case 403:
      return { code: "no_access" };
    case 404:
      return { code: "not_found" };
    case 409:
      return { code: "stale" };
    case 413:
      return { code: "too_large" };
    case 423:
      return { code: "locked" };
    case 503:
      return { code: "ledger_unavailable" };
    default:
      return { code: "refused" };
  }
}

/**
 * Propose each other-document edit group into that document's own ledger, where
 * its actor applies it to a fresh working copy. One unreachable document becomes
 * an error row, never a failed turn.
 */
export async function proposeCrossDoc(
  internal: InternalApi,
  groups: { docId: string; title: string; strEdits: AiStrEdit[]; citations: AiCitation[] }[],
  meta: SessionMeta,
  collectionId: string | null,
  panelAgent: string,
): Promise<AiCrossDocProposal[]> {
  const out: AiCrossDocProposal[] = [];
  for (const g of groups.filter((group) => group.strEdits.length > 0)) {
    try {
      const res = await post(internal, "/internal/propose-doc-edit", {
        doc_id: g.docId,
        principals: meta.principals,
        workspaceId: meta.workspaceId,
        alias: meta.alias,
        collection_id: collectionId,
        agent: panelAgent,
        edits: g.strEdits,
        citations: g.citations,
      });
      const data = (await res.json().catch(() => null)) as { kind?: string; pending?: number; applied?: number } | null;
      if (res.ok && data?.kind === "proposed") {
        out.push({ doc_id: g.docId, title: g.title, staged: data.pending ?? g.strEdits.length, mode: "proposed" });
      } else if (res.ok && data?.kind === "auto_applied") {
        out.push({ doc_id: g.docId, title: g.title, staged: data.applied ?? g.strEdits.length, mode: "applied" });
      } else if (res.ok && data?.kind === "noop") {
        out.push({ doc_id: g.docId, title: g.title, staged: 0, mode: "proposed" });
      } else {
        out.push({ doc_id: g.docId, title: g.title, staged: 0, mode: "error", error: res.ok ? { code: "refused" } : crossDocError(res.status) });
      }
    } catch {
      out.push({ doc_id: g.docId, title: g.title, staged: 0, mode: "error", error: { code: "unreachable" } });
    }
  }
  return out;
}

/** One message of a comment thread, as the node reads it: raw author ids, never display names. */
export interface ThreadMessage {
  num: number;
  parent_num: number | null;
  author: string;
  body: string;
  created_at: string;
}

/** A comment thread and the person's access now, which a socket's write tier may lag behind. */
export interface CommentThread {
  can_write: boolean;
  resolved: boolean;
  anchor_quote: string | null;
  /** The root first, then its replies by number. */
  messages: ThreadMessage[];
}

function isThreadMessage(m: unknown): m is ThreadMessage {
  const v = m as Partial<ThreadMessage> | null;
  return (
    !!v &&
    typeof v.num === "number" &&
    (v.parent_num === null || typeof v.parent_num === "number") &&
    typeof v.author === "string" &&
    typeof v.body === "string" &&
    typeof v.created_at === "string"
  );
}

/**
 * The thread rooted at `num` on this document, or null when it is gone (deleted, or the person can
 * no longer read the document). Throws when the node cannot say: a thread turn has no request without it.
 */
export async function fetchCommentThread(internal: InternalApi, docId: string, meta: SessionMeta, num: number): Promise<CommentThread | null> {
  const res = await post(internal, "/internal/comment-thread", {
    workspaceId: meta.workspaceId,
    principals: meta.principals,
    alias: meta.alias,
    doc_id: docId,
    num,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the comment thread could not be read (${res.status})`);
  const data = (await res.json().catch(() => null)) as Partial<CommentThread> | null;
  if (!data || !Array.isArray(data.messages) || !data.messages.every(isThreadMessage)) throw new Error("the comment thread could not be read");
  return {
    can_write: data.can_write === true,
    resolved: data.resolved === true,
    anchor_quote: typeof data.anchor_quote === "string" ? data.anchor_quote : null,
    messages: data.messages,
  };
}

/**
 * A comment the co-author posts: a reply in a thread, named by its root's number and `created_at`
 * (a deleted root's number can come back), or a question anchored to a passage (quote-only when unpinned).
 */
export type PanelComment =
  | { body: string; parent_num: number; parent_created_at: string }
  | { body: string; anchor_start: string | null; anchor_end: string | null; anchor_quote: string };

/**
 * Post a comment as the person's co-author (`panel:<alias>`). The node tells no one, so the caller
 * tells this document's pages. A refusal carries the node's reason, in words for the model.
 */
export async function postPanelComment(
  internal: InternalApi,
  docId: string,
  meta: SessionMeta,
  comment: PanelComment,
): Promise<{ num: number } | { error: string }> {
  try {
    const res = await post(internal, "/internal/comment", {
      workspaceId: meta.workspaceId,
      principals: meta.principals,
      alias: meta.alias,
      doc_id: docId,
      ...comment,
    });
    const data = (await res.json().catch(() => null)) as { num?: unknown; error?: unknown } | null;
    if (res.ok && typeof data?.num === "number") return { num: data.num };
    return { error: typeof data?.error === "string" ? data.error : `refused (${res.status})` };
  } catch (e) {
    console.warn("co-author comment not posted", { docId, err: String(e) });
    return { error: "the server could not be reached" };
  }
}

/**
 * Tell the person of the questions a turn asked while they had no page open here. The node rechecks
 * each question and their access; a failure costs only the notification.
 */
export async function notifyAsked(internal: InternalApi, docId: string, meta: SessionMeta, nums: number[]): Promise<void> {
  try {
    const res = await post(internal, "/internal/coauthor-asked", {
      workspaceId: meta.workspaceId,
      principals: meta.principals,
      alias: meta.alias,
      doc_id: docId,
      nums,
    });
    if (!res.ok) console.warn("co-author questions not notified", { docId, status: res.status });
  } catch (e) {
    console.warn("co-author questions not notified", { docId, err: String(e) });
  }
}
