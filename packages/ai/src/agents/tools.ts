import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import type { ToolSpec } from "../types.js";

/** Characters one read_document call may return. */
export const READ_CHUNK_MAX = 12_000;

/**
 * Per-round output budget. A reasoning model spends output tokens before its
 * tool-call JSON, and one large str_replace can carry a 1–2K-token old_string;
 * a small cap ends the round at `max_tokens` with no tool call emitted.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

/** Offered only when a Collection is in scope; a tool that can only fail teaches the model to distrust its tools. */
export const SEARCH_COLLECTION_TOOL: ToolSpec = {
  name: "search_collection",
  description: "Search the selected knowledge base of documents; returns cited passages.",
  inputSchema: {
    json: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
    },
  },
};

/**
 * Append one search's citations, numbered after those already collected. The
 * runner numbers the passages in its result text from the same offset, so the
 * [n] the model reads is the citation's final number.
 */
export function appendCitations(into: AiCitation[], found: AiCitation[]): void {
  for (const c of found) into.push({ ...c, n: into.length + 1 });
}
