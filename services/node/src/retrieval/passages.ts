import type { RerankCandidate } from "@stuga/ai";
import { type AiCitation, CITATION_EXCERPT_CHARS } from "@stuga/protocol/wire/doc-socket";

/** Citations for retrieved passages, numbered from the turn's running offset so `[n]` in the text is the citation's number. */
export function passageCitations(chunks: RerankCandidate[], offset: number): AiCitation[] {
  return chunks.map((c, i) => ({
    n: offset + i + 1,
    doc_id: c.doc_id,
    title: c.title,
    heading_path: c.heading_path ?? null,
    content: (c.content ?? "").slice(0, CITATION_EXCERPT_CHARS),
  }));
}
