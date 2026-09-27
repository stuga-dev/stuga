import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import { textTool } from "./loop.js";

/** Characters one read_document call may return. */
export const READ_CHUNK_MAX = 12_000;

/**
 * Per-round output budget. A reasoning model spends output tokens before its
 * tool-call JSON, and one large str_replace can carry a 1–2K-token old_string;
 * a small cap ends the round at `max_tokens` with no tool call emitted.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

/** A search query, trimmed; blank is refused. */
export function queryOf(query: string): string {
  const q = query.trim();
  if (!q) throw new Error("query is required");
  return q;
}

/**
 * Offered only when a Collection is in scope; a tool that can only fail teaches
 * the model to distrust its tools. `run` gets the trimmed query.
 */
export function searchCollectionTool(run: (query: string) => Promise<string>): AgentTool {
  return textTool(
    "search_collection",
    "Search the selected knowledge base of documents; returns cited passages.",
    Type.Object({ query: Type.String({ description: "What to search for." }) }),
    async ({ query }) => run(queryOf(query)),
  );
}

/**
 * Append one search's citations, numbered after those already collected. The
 * runner numbers the passages in its result text from the same offset, so the
 * [n] the model reads is the citation's final number.
 */
export function appendCitations(into: AiCitation[], found: AiCitation[]): void {
  for (const c of found) into.push({ ...c, n: into.length + 1 });
}
