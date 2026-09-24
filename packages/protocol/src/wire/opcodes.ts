/**
 * WebSocket opcode table. Every binary frame is `[1-byte opcode][payload]`;
 * unknown opcodes are ignored at both ends. Nothing outside this file may
 * hardcode a numeric opcode.
 *
 * Families are 0x10 wide and 0x00–0x1F is never assigned, so a zero-filled or
 * control-byte-prefixed buffer cannot decode as a valid frame.
 */
export const Opcode = {
  // ---- 0x2x — document sync core ----
  /** C<->S  Yjs state vector: "here is my state, send what I lack". */
  SYNC_STEP_1: 0x20,
  /** C<->S  Yjs update bytes answering a state vector. */
  SYNC_STEP_2: 0x21,
  /** C<->S  live incremental Yjs update. */
  UPDATE: 0x22,

  // ---- 0x3x — collaboration side-channels ----
  /** C<->S  presence and cursors; layout owned by `encodeAwareness` in frame.ts. */
  AWARENESS: 0x30,

  // ---- 0x4x — receipts and session lifecycle ----
  /**
   * S->C  (no payload) — "I accepted and broadcast your update." Proves
   * acceptance, not durability: storage failures are reported by PERSIST_DEGRADED.
   */
  UPDATE_ACK: 0x40,
  /** S->C  (no payload) — initial sync for this socket is complete. */
  SYNC_DONE: 0x41,
  /** S->C  JSON `{ kind, message }` — the server refused a write. */
  WRITE_REJECTED: 0x42,
  /** S->C  (no payload) — document rolled back; drop the Y.Doc and reload. */
  DOC_RESET: 0x43,
  /**
   * S->C  u64 LE — the document's current rollback generation, sent before
   * SYNC_STEP_1. Writes from a socket that has not echoed the current value are
   * refused, which fences a tab that was offline during a rollback.
   */
  DOCUMENT_EPOCH: 0x44,
  /** C->S  u64 LE — "my state belongs to this generation." */
  DOCUMENT_EPOCH_ACK: 0x45,
  /**
   * S->C  JSON PersistDegradedPayload — the actor's durable flush started
   * failing or recovered. Sent on each transition and at handshake while
   * degraded. Advisory: writes are still accepted and the flush keeps retrying.
   */
  PERSIST_DEGRADED: 0x46,

  // ---- 0x5x — AI co-author ----
  /** C->S  JSON AiRequest. */
  AI_REQUEST: 0x50,
  /** S->C  JSON AiResponseChunk — streamed prose. */
  AI_RESPONSE: 0x51,
  /** S->C  JSON AiEditsPayload; exactly one per turn. */
  AI_EDITS: 0x52,
  /**
   * C->S  (no payload) — stop the turn in flight on this socket. The turn still
   * ends with AI_RESPONSE `done` then AI_EDITS. The actor must handle this ahead
   * of its queue, because a running turn holds the actor's lock.
   */
  AI_CANCEL: 0x53,

  // ---- 0x6x — agent-run review ledger (reviewer's non-agent sockets only) ----
  /** S->C  JSON RunUpdatedPayload. */
  RUN_UPDATED: 0x60,
  /** S->C  JSON RunDecidedPayload. */
  RUN_DECIDED: 0x61,

  // ---- 0x7x — structured-database channel (no Yjs) ----
  /** S->C  JSON DatabaseRunUpdatedPayload — reviewer's human sockets only. */
  DB_RUN_UPDATED: 0x70,
  /** S->C  JSON DatabaseRunDecidedPayload — same audience. */
  DB_RUN_DECIDED: 0x71,
  /** S->C  JSON DatabaseChangedPayload — rows or schema changed; refetch. */
  DB_CHANGED: 0x72,
} as const;

export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode];

/** WebSocket close codes with project-specific meaning. */
export const CloseCode = {
  /** Access revoked mid-session — the client must NOT reconnect. */
  ACCESS_REVOKED: 4403,
  /** Rolled back to an older version — the client must reload for a fresh sync. */
  DOC_RESET: 4408,
} as const;

/**
 * Keepalive STRING messages: the client sends PING on a timer and the actor
 * host answers PONG without dispatching to the actor. Binary handlers ignore
 * strings, so these cannot collide with the opcode table.
 */
export const Heartbeat = {
  PING: "ping",
  PONG: "pong",
} as const;

export interface PersistDegradedPayload {
  /** True on entering the degraded state, false when a flush succeeds again. */
  degraded: boolean;
}

/** Reasons a server may refuse a write (the payload of WRITE_REJECTED). */
export type WriteRejectedKind =
  | "acl"
  | "locked"
  | "table-cap"
  | "structural-rate"
  | "rate-limit"
  /** The socket never acknowledged the current DOCUMENT_EPOCH; it is closed with DOC_RESET. */
  | "epoch"
  /** Agent sockets may not write raw Yjs; agent edits go through the propose API. */
  | "approval_required";
