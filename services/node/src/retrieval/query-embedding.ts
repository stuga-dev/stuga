/**
 * Search's query vectors, kept for a while. Search runs as a person types, so the
 * same query comes back often (a word retyped, the palette reopened, "Search all"
 * after the palette), and each provider call costs tokens and a usage row.
 *
 * The key holds the workspace and the caller (a person, or one agent key), so a
 * fast answer says nothing about what anyone else searched, and the endpoint,
 * model and width, so a settings change misses. Retyping is one caller's habit,
 * so keeping per caller costs few hits. A caller's identical queries in flight
 * share one call.
 */
import { type AiConfig, embed } from "@stuga/ai";

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

interface Entry {
  at: number;
  vector: Promise<number[]>;
}

const cache = new Map<string, Entry>();

export interface QueryEmbedding {
  embedding: number[];
  /** Whether this call reached the provider, and so is the one to record usage for. */
  called: boolean;
  inputTokens: number;
}

/** Throws as embed() does; a failure is not kept. */
export async function embedQuery(ai: AiConfig, workspaceId: string, alias: string, query: string): Promise<QueryEmbedding> {
  const { provider, baseUrl, model, dims } = ai.embed;
  const key = JSON.stringify([workspaceId, alias, provider, baseUrl, model, dims, query]);
  const now = Date.now();
  const kept = cache.get(key);
  if (kept && now - kept.at < TTL_MS) {
    // Most recently used last, so eviction takes the stalest.
    cache.delete(key);
    cache.set(key, kept);
    return { embedding: await kept.vector, called: false, inputTokens: 0 };
  }

  const call = embed(ai, [query]).then((res) => {
    const embedding = res.embeddings[0];
    if (!embedding) throw new Error("embed: no vector for the query");
    return { embedding, inputTokens: res.inputTokens };
  });
  const entry: Entry = { at: now, vector: call.then((r) => r.embedding) };
  // A failed call's waiters see the rejection; the entry itself must not raise an unhandled one.
  entry.vector.catch(() => {});
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);

  try {
    const { embedding, inputTokens } = await call;
    return { embedding, called: true, inputTokens };
  } catch (e) {
    if (cache.get(key) === entry) cache.delete(key);
    throw e;
  }
}
