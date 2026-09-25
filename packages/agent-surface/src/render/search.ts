/**
 * Search and retrieval answers, merged across the workspaces a call covered.
 * An empty result has causes an agent must tell apart (no match, a collection
 * this credential cannot read, no embeddings, a workspace it could not reach).
 * Only the node knows which, so these report its flags and never infer one
 * from an empty list.
 */
import type { RetrieveBody, SearchBody } from "../backend.js";
import { interleaveByRank } from "../merge.js";

export const EMPTY_SCOPE_NOTE =
  "This collection resolved to 0 documents this connector can access. The collection may be empty, or " +
  "its documents may not be shared with this connector — ask the workspace owner to share them.";

/** Agent skills match the leading "AI chat is disabled on this node" verbatim to fall back to keyword search. */
export const RETRIEVE_AI_DISABLED_MESSAGE =
  "AI chat is disabled on this node for retrieval (embeddings are off) — use `search` for keyword search instead";

/** A workspace a call named but could not cover just now, and why. */
export interface UnavailableWorkspace {
  workspace_id: string;
  reason: string;
}

/** One workspace's answer, with the origin its documents are linked from ("" when there is none). */
export interface WorkspacePart<T> {
  workspace_id: string;
  origin: string;
  body: T;
}

const DEFAULT_SEARCH_RESULTS = 20;
const DEFAULT_PASSAGES = 8;

const link = (origin: string, docId: string): string | undefined => (origin ? `${origin}/doc/${docId}` : undefined);

/** Documents in rank order across workspaces, each naming its workspace. Per-workspace scores are dropped: they do not compare. */
export function renderSearch(
  query: string,
  parts: ReadonlyArray<WorkspacePart<SearchBody>>,
  unavailable: readonly UnavailableWorkspace[],
  limit = DEFAULT_SEARCH_RESULTS,
): string {
  const results = interleaveByRank(
    parts.map((p) =>
      p.body.results.map(({ score: _score, sem_score: _sem, ...hit }) => ({ workspace_id: p.workspace_id, ...hit, url: link(p.origin, hit.doc_id) })),
    ),
    limit,
  );
  return JSON.stringify({
    query,
    results,
    // Both can be true at once, and the agent needs both to describe what it saw.
    degraded: parts.some((p) => p.body.degraded),
    semantic: parts.length > 0 && parts.every((p) => p.body.semantic),
    unavailable,
    ...(parts.length === 1 && parts[0]!.body.empty_scope ? { note: EMPTY_SCOPE_NOTE } : {}),
  });
}

/** Passages in rank order across workspaces, as citable excerpts with a link when there is an origin to build it from. */
export function renderPassages(
  parts: ReadonlyArray<WorkspacePart<RetrieveBody>>,
  unavailable: readonly UnavailableWorkspace[],
  limit = DEFAULT_PASSAGES,
): string {
  const passages = interleaveByRank(
    parts.map((p) =>
      p.body.chunks.map((c) => ({
        workspace_id: p.workspace_id,
        doc_id: c.doc_id,
        title: c.title,
        heading_path: c.heading_path,
        content: c.content,
        url: link(p.origin, c.doc_id),
      })),
    ),
    limit,
  );
  return JSON.stringify({
    passages,
    degraded: parts.some((p) => p.body.degraded === true),
    unavailable,
    ...(parts.length === 1 && parts[0]!.body.empty_scope ? { note: EMPTY_SCOPE_NOTE } : {}),
  });
}
