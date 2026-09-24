/**
 * The co-author's calls back into the node. The actor holds no database, so
 * reads, search, media ingest and proposals into other documents go through the
 * internal API carrying the session's principals, and the node enforces the ACL.
 * Every call degrades rather than failing the turn.
 */
import { parseInstructionLevels, type InstructionLevel } from "@stuga/protocol/domain/instructions";
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
 * the destination the reviewer sees is the one that lands. Returns a warning, or
 * "" — an image that could not be fetched never costs the turn.
 */
export async function hostAgentImages(internal: InternalApi, docId: string, edits: AiStrEdit[], meta: SessionMeta): Promise<string> {
  const targets = edits.filter((e) => e.new_string.includes("!["));
  if (targets.length === 0) return "";
  try {
    const res = await post(internal, "/internal/media-ingest", {
      doc_id: docId,
      principals: meta.principals,
      workspaceId: meta.workspaceId,
      markdown: targets.map((e) => e.new_string),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { markdown?: string[]; warning?: string };
    // Paired by index, so an answer of the wrong length is dropped rather than misapplied.
    if (!Array.isArray(data.markdown) || data.markdown.length !== targets.length) return "";
    targets.forEach((e, i) => {
      e.new_string = data.markdown![i]!;
    });
    return typeof data.warning === "string" ? data.warning : "";
  } catch {
    return "";
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
  panelAlias: string,
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
        panel_alias: panelAlias,
        agent: panelAgent,
        edits: g.strEdits,
        citations: g.citations,
      });
      const data = (await res.json().catch(() => null)) as { kind?: string; pending?: number; message?: string } | null;
      if (res.ok && (data?.kind === "proposed" || data?.kind === "auto_applied")) {
        out.push({ doc_id: g.docId, title: g.title, staged: data.pending ?? g.strEdits.length, mode: "proposed" });
      } else if (res.ok && data?.kind === "noop") {
        out.push({ doc_id: g.docId, title: g.title, staged: 0, mode: "proposed" });
      } else {
        out.push({ doc_id: g.docId, title: g.title, staged: 0, mode: "error", message: data?.message ?? "the edits were refused" });
      }
    } catch {
      out.push({ doc_id: g.docId, title: g.title, staged: 0, mode: "error", message: "that document was unreachable" });
    }
  }
  return out;
}
