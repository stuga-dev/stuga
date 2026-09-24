import type { ReviewMode } from "../domain/events.js";
import type { WriteRejectedKind } from "./opcodes.js";

/** Who sent an AWARENESS frame; the Yjs payload carries what changed. */
export interface AwarenessHeader {
  alias: string;
  agent?: string;
}

// ---- AI co-author ----------------------------------------------------------

export interface AiHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  prompt: string;
  selected_text: string | null;
  /** A model id from `GET /api/models`, or "auto" for the configured default. */
  model: string;
  history: AiHistoryItem[];
  /**
   * Scope of the co-author's search_collection tool: a Collection id,
   * ALL_DOCUMENTS_SCOPE for everything the user can see, or absent/null for no
   * cross-document search this turn.
   */
  collection_id?: string | null;
  /** Images already uploaded to the document's media store for this turn; only paths travel. */
  attachments?: AiAttachment[];
}

export interface AiAttachment {
  /** Stored media path: `/api/docs/:id/media/:hash`. */
  url: string;
  /** Original filename; the default alt text. */
  name: string;
  mime: string;
}

/** `collection_id` sentinel: search every document the user can see (ACL only). */
export const ALL_DOCUMENTS_SCOPE = "__all__";

export interface AiResponseChunk {
  chunk?: string;
  /** Activity label while no prose is streaming, e.g. "Thinking…". Carries no document data. */
  status?: string;
  done: boolean;
  error?: string | null;
}

/**
 * Terminal frame of one co-author turn, sent exactly once per turn including on
 * error. A receipt: the edits are already in the document's run ledger (source
 * "panel", reviewer = the requesting human) and are reviewed there.
 */
export interface AiEditsPayload {
  /** Hunks staged on THIS document. 0 = a pure-answer turn. */
  staged: number;
  /** The run they landed in, or null when nothing was staged. */
  run_id: string | null;
  /** Proposals raised in other documents this turn. */
  cross_docs: AiCrossDocProposal[];
  citations?: AiCitation[];
  error: string | null;
  /** The turn ended incomplete but still staged work (round cap, or a later round failed). */
  notice: string | null;
}

/** A pointer to proposals parked in another document's ledger. */
export interface AiCrossDocProposal {
  doc_id: string;
  /** Display title at read time. */
  title: string;
  staged: number;
  mode: "proposed" | "error";
  message?: string;
}

/** One find/replace edit, the unit a run hunk is built from. */
export interface AiStrEdit {
  old_string: string;
  new_string: string;
}

/** A cited knowledge-base source. */
export interface AiCitation {
  n: number;
  doc_id: string;
  title: string;
  heading_path?: string | null;
  /** Excerpt of the passage frozen at answer time; empty when the agent cited none. */
  content: string;
}

/** Max chars of referenced text carried in a citation. */
export const CITATION_EXCERPT_CHARS = 300;

// ---- Write rejection -------------------------------------------------------

export interface WriteRejectedPayload {
  kind: WriteRejectedKind;
  message: string;
}

// ---- Agent-edit review ("Runs") --------------------------------------------
//
// A Run is one agent's editing session on one document inside the DocActor: a
// list of find/replace hunks a human accepts or rejects, or that apply at once
// when the document is set to `auto`.

export type AgentRunSource = "connector" | "stdio" | "panel";

export type RunHunkStatus = "pending" | "accepted" | "rejected" | "conflict" | "auto_applied";

export interface AgentRunHunk {
  /** "h1","h2",… unique within the run, stable. */
  id: string;
  old_string: string;
  new_string: string;
  status: RunHunkStatus;
  /** The mode it was proposed under; a `review` hunk never rides along on a later `auto` proposal. */
  review: ReviewMode;
}

export type AgentRunStatus = "open" | "applied" | "rejected" | "expired";

/** Wire summary of an agent Run (WS frames + REST). */
export interface AgentRunSummary {
  /** "run_<12 hex>" */
  id: string;
  doc_id: string;
  source: AgentRunSource;
  /** Display name, e.g. "Claude (Connector)". */
  agent: string;
  /** Alias of the agent principal (run identity key). */
  agent_alias: string;
  /** The `x-stuga-client` label the agent sent. */
  client?: string;
  /** The `x-stuga-model` label, or the model the in-app co-author ran. */
  model?: string;
  /** Alias of the human who reviews. */
  reviewer: string;
  status: AgentRunStatus;
  /** Elided when huge — see hunks_truncated. */
  hunks: AgentRunHunk[];
  /** true → fetch full detail via REST. */
  hunks_truncated?: boolean;
  /** Catch-up card dismissed. */
  acknowledged: boolean;
  /** true if any hunk auto-applied because the document is set to `auto`. */
  auto_applied: boolean;
  /** true once the run's applied hunks were reverted. */
  reverted?: boolean;
  /** The strictest review mode any proposal in this run carried. */
  review_mode: ReviewMode;
  /** epoch ms */
  created_at: number;
  updated_at: number;
  seq_at_commit?: number;
}

/** Payload of RUN_UPDATED. */
export interface RunUpdatedPayload {
  run: AgentRunSummary;
}

/** Payload of RUN_DECIDED. */
export interface RunDecidedPayload {
  run_id: string;
  decision: "accept" | "reject";
  hunk_ids: string[];
  /** Alias, or "policy:auto" where the document's `auto` setting landed it. */
  decided_by: string;
  /** Post-decision state. */
  run: AgentRunSummary;
}
