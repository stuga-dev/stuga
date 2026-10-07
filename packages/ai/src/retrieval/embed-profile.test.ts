/** Embedding profiles: a model is known by name under whichever server's naming it is listed. */
import { describe, it, expect } from "vitest";
import { embedProfile } from "./embed-profile.js";

const GEMMA = { query: "task: search result | query: ", document: "title: none | text: ", dims: 768, shortens: [512, 256, 128] };
const QWEN_QUERY = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";

describe("embedProfile", () => {
  it("knows EmbeddingGemma as Ollama, Hugging Face and LM Studio name it", () => {
    for (const id of ["embeddinggemma-2", "embeddinggemma-2:270m", "google/embeddinggemma-2", "text-embedding-embeddinggemma-300m-qat", "EmbeddingGemma:300m"]) {
      expect(embedProfile(id), id).toEqual(GEMMA);
    }
  });

  it("reads Qwen3-Embedding's width from its size, untagged being Ollama's 8B", () => {
    expect(embedProfile("qwen3-embedding:0.6b")).toEqual({ query: QWEN_QUERY, document: "", dims: 1024 });
    expect(embedProfile("Qwen/Qwen3-Embedding-4B").dims).toBe(2560);
    expect(embedProfile("text-embedding-qwen3-embedding-8b").dims).toBe(4096);
    expect(embedProfile("qwen3-embedding").dims).toBe(4096);
    expect(embedProfile("qwen3-embedding:latest").dims).toBe(4096);
  });

  it("gives each family its own prompts", () => {
    expect(embedProfile("nomic-embed-text:latest")).toMatchObject({ query: "search_query: ", document: "search_document: " });
    expect(embedProfile("nomic-ai/nomic-embed-text-v2-moe")).toMatchObject({ query: "search_query: ", document: "search_document: " });
    expect(embedProfile("intfloat/multilingual-e5-large")).toMatchObject({ query: "query: ", document: "passage: " });
    expect(embedProfile("multilingual-e5-large-instruct").query).toMatch(/^Instruct: .*\nQuery: $/);
    expect(embedProfile("snowflake-arctic-embed2")).toEqual({ query: "query: ", document: "", dims: 1024 });
    expect(embedProfile("snowflake-arctic-embed:335m").query).toBe("Represent this sentence for searching relevant passages: ");
    expect(embedProfile("mxbai-embed-large").dims).toBe(1024);
  });

  it("sends an unknown or prompt-free model its text as it is", () => {
    for (const id of ["text-embedding-3-large", "all-minilm", "gemini-embedding-001", "bge-m3"]) {
      expect(embedProfile(id), id).toMatchObject({ query: "", document: "" });
    }
    expect(embedProfile("text-embedding-3-large").dims).toBeNull();
    expect(embedProfile("bge-m3").dims).toBe(1024);
  });
});
