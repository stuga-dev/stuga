/**
 * What the built-in AI's panels (Ask, the table assistant, the document co-author) tell the person
 * about a turn: what it is doing, why it ended early, why it failed. The node sends codes and
 * values, never sentences, and the app words them in the reader's language.
 */
import type { AiCitation } from "../wire/doc-socket.js";

/** Why a model call failed. `cut_off` and `unparseable` are answers that arrived but could not be used. */
export type ModelFailureKind = "quota" | "auth" | "rate_limit" | "unavailable" | "rejected" | "cut_off" | "unparseable" | "error";

// ---- Ask -------------------------------------------------------------------

/** What the ask agent is doing between prose bursts: the `status` event. */
export type AskActivity =
  | { kind: "thinking" }
  | { kind: "searching"; query: string }
  /** `title` is empty for an untitled document. */
  | { kind: "reading"; title: string }
  | { kind: "listing" }
  /** Running SQL against one structured database. */
  | { kind: "querying"; title: string };

/** The caveat under an answer that was not a clean, fully grounded finish. */
export type AskNotice =
  | { code: "max_rounds" }
  | { code: "budget" }
  | { code: "aborted" }
  /** `failure` is null when there is nothing plainer to say than that it failed. */
  | { code: "error"; failure: ModelFailureKind | null }
  /** Semantic search was unavailable, so retrieval matched words only. */
  | { code: "degraded" };

// ---- Table assistant -------------------------------------------------------

/** What the table assistant is doing before it streams prose: the `status` event. */
export type TableAiActivity =
  | { kind: "thinking" }
  /** Reading the schema. */
  | { kind: "reading" }
  | { kind: "querying" }
  | { kind: "searching"; query: string }
  | { kind: "proposing" };

/** A table assistant turn that ended incomplete but still made changes. */
export type TableAiNotice =
  | { code: "max_rounds"; rounds: number }
  /** A later round failed; the changes before it are `staged` for review or were `applied`. */
  | { code: "ended_early"; kept: "staged" | "applied"; failure: ModelFailureKind | null };

/** The `done` event of a table assistant turn. */
export interface TableAiDone {
  staged: number;
  applied: number;
  run_id: string | null;
  citations: AiCitation[];
  notice: TableAiNotice | null;
}

/** The `error` event of a table assistant turn: `message` for scripts, `failure` for the app. */
export interface TableAiError {
  message: string;
  failure: ModelFailureKind | null;
}

// ---- Document co-author ----------------------------------------------------

/** What the co-author is doing while no prose streams. Carries no document data beyond a search query. */
export type CoauthorActivity =
  | { kind: "thinking" }
  /** Reading the open document. */
  | { kind: "reading" }
  /** An empty `query` searches the knowledge base at large. */
  | { kind: "searching"; query: string }
  | { kind: "editing" }
  /** Staging the turn's edits for review, or with `applying` applying them at once. */
  | { kind: "proposing" }
  | { kind: "applying" };

/** What the person should know about a turn that otherwise stands; a turn can carry several, in order. */
export type CoauthorNotice =
  | { code: "max_rounds"; rounds: number }
  | { code: "ended_early"; failure: ModelFailureKind | null }
  /** Stopped by the person; what it had made is `staged` for review, was `applied`, or there was none. */
  | { code: "stopped"; kept: "staged" | "applied" | null }
  /** An image the turn linked could not be downloaded into the workspace; the link stayed as written. */
  | { code: "image_not_downloaded"; url: string; reason: string }
  /** Only the first `count` images were downloaded; the rest kept their links. */
  | { code: "images_truncated"; count: number };

/** Why a co-author turn failed, or why its edits could not be staged. */
export type CoauthorError =
  | { code: "locked" }
  /** The document is in the trash. */
  | { code: "trashed" }
  | { code: "view_only" }
  | { code: "rate_limited" }
  | { code: "unreadable" }
  | { code: "empty_prompt" }
  /** An agent's socket: agents use the MCP tools. */
  | { code: "agent" }
  | { code: "ai_disabled" }
  /** The model call failed with nothing to show; `detail` is an unexpected error's own text. */
  | { code: "failed"; failure: ModelFailureKind | null; detail?: string }
  /** The edits could not be staged: */
  | { code: "propose_locked" }
  | { code: "too_large" }
  | { code: "ledger_unavailable" }
  | { code: "stale" }
  /** `count` proposals already wait for review on this document; a new run waits until some are decided. */
  | { code: "review_backlog"; count: number }
  | { code: "propose_failed"; detail?: string }
  /** The app's own: the socket closed while the turn ran. */
  | { code: "dropped" };

/** Why a co-author turn's edits to another document were not proposed there. */
export type CrossDocError =
  | { code: "locked" }
  /** No write access, or outside the documents the turn may reach. */
  | { code: "no_access" }
  /** Gone, or its collection is no longer available. */
  | { code: "not_found" }
  | { code: "too_large" }
  /** The document changed while the model wrote. */
  | { code: "stale" }
  | { code: "ledger_unavailable" }
  /** The node could not be asked. */
  | { code: "unreachable" }
  | { code: "refused" };
