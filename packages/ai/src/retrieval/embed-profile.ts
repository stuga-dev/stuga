/**
 * What a known embedding model needs beyond the text: the instruction it was
 * trained to see before a query or a passage, and the width it returns. Models
 * are told apart by name, whichever server runs them (`embeddinggemma-2:270m`,
 * `google/embeddinggemma-2`, `text-embedding-embeddinggemma-2`); an unknown
 * model gets its text as it is. Servers add none of these themselves, so the
 * node does. The prompts are the models' own (their sentence-transformers
 * `query` and `document` prompts, or their model cards).
 */

/** A search query, or a passage being indexed: most retrieval models embed the two differently. */
export type EmbedRole = "query" | "document";

export interface EmbedProfile {
  /** Before a query. */
  query: string;
  /** Before a passage. */
  document: string;
  /** The width the model returns unasked, when the name settles it. */
  dims: number | null;
  /** The shorter widths it can return, widest first, when not just any width. */
  shortens?: number[];
}

const RAW: EmbedProfile = { query: "", document: "", dims: null };

const SEARCH_PASSAGES = "Represent this sentence for searching relevant passages: ";

/** First match wins, so a narrower pattern sits above a broader one. */
const PROFILES: Array<{ name: RegExp; profile: EmbedProfile | ((id: string) => EmbedProfile) }> = [
  // EmbeddingGemma 1 and 2. A titled passage may say `title: {title}`; the title is already in chunk 0's text.
  {
    name: /embeddinggemma/,
    profile: { query: "task: search result | query: ", document: "title: none | text: ", dims: 768, shortens: [512, 256, 128] },
  },
  {
    name: /qwen3-embedding/,
    profile: (id) => ({
      query: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
      document: "",
      // Untagged is Ollama's `latest`, the 8B.
      dims: /0\.6b/.test(id) ? 1024 : /4b/.test(id) ? 2560 : 4096,
    }),
  },
  // v1, v1.5 and v2-moe.
  { name: /nomic-embed-text/, profile: { query: "search_query: ", document: "search_document: ", dims: 768 } },
  { name: /mxbai-embed-large/, profile: { query: SEARCH_PASSAGES, document: "", dims: 1024 } },
  { name: /arctic-embed2|arctic-embed-l-v2/, profile: { query: "query: ", document: "", dims: 1024 } },
  { name: /arctic-embed-m-v2/, profile: { query: "query: ", document: "", dims: 768 } },
  { name: /arctic-embed/, profile: { query: SEARCH_PASSAGES, document: "", dims: null } },
  {
    name: /e5-.*instruct|e5-mistral/,
    profile: { query: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ", document: "", dims: null },
  },
  { name: /(^|[/:_-])(multilingual-)?e5-/, profile: { query: "query: ", document: "passage: ", dims: null } },
  { name: /bge-m3/, profile: { query: "", document: "", dims: 1024 } },
];

export function embedProfile(model: string): EmbedProfile {
  const id = model.toLowerCase();
  const hit = PROFILES.find((p) => p.name.test(id));
  if (!hit) return RAW;
  return typeof hit.profile === "function" ? hit.profile(id) : hit.profile;
}
