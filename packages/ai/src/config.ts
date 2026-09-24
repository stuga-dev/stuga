/** AI configuration: chat and embeddings go to operator-configured endpoints. */
export type AiProvider = "anthropic" | "openai" | "ollama";

/** A model the UI offers. `id` is the provider's own model name. */
export interface AiModelChoice {
  id: string;
  name: string;
}

export interface AiEndpoint {
  provider: AiProvider;
  /** e.g. https://api.anthropic.com, https://api.openai.com/v1, http://127.0.0.1:11434 */
  baseUrl: string;
  /** Not needed for a local Ollama. */
  apiKey?: string;
}

/** One configured chat provider. `id` identifies it across edits and is never sent to the vendor. */
export type ChatEndpoint = AiEndpoint & {
  id: string;
  /** Offered through `GET /api/models`; ids are unique across all endpoints. */
  models: AiModelChoice[];
};

export interface AiConfig {
  /**
   * True when either half is on. Chat and embeddings switch independently:
   * chat without embeddings keeps search keyword-only, and embeddings without
   * chat serve semantic search to outside agents with no in-app AI.
   */
  enabled: boolean;
  chat: {
    /** In-app chat surfaces: the co-author, Ask, table AI, rerank. */
    enabled: boolean;
    /** The client id "auto" resolves to. */
    defaultModel: string;
    /** In display order; never empty once resolved (a local Ollama default fills in). */
    endpoints: ChatEndpoint[];
  };
  embed: AiEndpoint & {
    /** Documents are embedded and semantic search runs. */
    enabled: boolean;
    model: string;
    /** Must match the `vector(N)` column. */
    dims: number;
    /** Search keeps a chunk only below this cosine distance to the query; how far a match sits depends on the model. */
    searchMaxDistance: number;
    /** The same cutoff for retrieval: Ask, agents' retrieve, and the assistants' document search. */
    retrievalMaxDistance: number;
  };
}
