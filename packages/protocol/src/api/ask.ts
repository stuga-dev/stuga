import type { AiCitation } from "../wire/doc-socket.js";

/** One research step the ask agent took, streamed as it completes and stored with the turn. */
export type AskStep =
  | { kind: "search"; query: string; hits: number }
  | { kind: "read"; doc_id: string; title: string; chars: number }
  | { kind: "list"; count: number; folders: number; query: string | null }
  /** A read-only SQL query against one structured database. */
  | { kind: "query"; database_id: string; title: string; sql: string; rows: number };

/** Why an agent turn ended. Only "complete" is a clean finish; the rest still carry real prose, citations and steps. */
export type AskStopReason = "complete" | "max_rounds" | "aborted" | "budget" | "error";

/** The terminal `done` frame of an ask stream. */
export interface AskDone {
  citations: AiCitation[];
  rounds: number;
  stop_reason: AskStopReason;
  /** What an incomplete or degraded answer is missing; not an error. */
  notice: string | null;
}
