/**
 * An empty result has three causes an agent must tell apart (no match, a
 * collection this credential cannot read, no embeddings). Only the node knows
 * which, so these report its flags and never infer one from an empty list.
 */
import type { RetrieveBody, SearchBody } from "../backend.js";

export const EMPTY_SCOPE_NOTE =
  "This collection resolved to 0 documents this connector can access. The collection may be empty, or " +
  "its documents may not be shared with this connector — ask the workspace owner to share them.";

/** Agent skills match the leading "AI chat is disabled on this node" verbatim to fall back to keyword search. */
export const RETRIEVE_AI_DISABLED_MESSAGE =
  "AI chat is disabled on this node for retrieval (embeddings are off) — use `docs` action:search for keyword search instead";

/** Chunks as citable passages; a link only when there is an origin to build it from. */
export function renderPassages(res: RetrieveBody, origin: string): string {
  return JSON.stringify({
    passages: res.chunks.map((c) => ({
      doc_id: c.doc_id,
      title: c.title,
      heading_path: c.heading_path,
      content: c.content,
      url: origin ? `${origin}/doc/${c.doc_id}` : undefined,
    })),
    // Both can be true at once, and the agent needs both to describe what it saw.
    degraded: res.degraded === true,
    ...(res.empty_scope ? { note: EMPTY_SCOPE_NOTE } : {}),
  });
}

export function renderSearch(res: SearchBody): string {
  return JSON.stringify(res.empty_scope ? { ...res, note: EMPTY_SCOPE_NOTE } : res);
}
