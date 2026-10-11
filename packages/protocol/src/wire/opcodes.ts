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
  /**
   * S->C  (no payload) — a comment was added, resolved, reopened or deleted;
   * re-read the comments. Carries nothing, so it discloses nothing the reader
   * cannot already fetch.
   */
  COMMENTS_CHANGED: 0x31,
  /** S->C  JSON TitleChangedPayload — someone renamed the document. */
  TITLE_CHANGED: 0x32,

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
  /**
   * S->C  (no payload, or JSON DocResetPayload) — document rolled back; drop
   * the Y.Doc and reload.
   */
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
  /**
   * S->C  JSON DocStatePayload — what this socket may do now: sent after each
   * handshake and to every socket when the lock, the trash or its write tier
   * changes. A level, never a refusal: nothing is audited for it.
   */
  DOC_STATE: 0x47,

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
  /** The item was deleted for good — the client must NOT reconnect. */
  DOC_DELETED: 4404,
  /** Rolled back to an older version — the client must reload for a fresh sync. */
  DOC_RESET: 4408,
  /** The person's role in the workspace changed — reconnect with a fresh ticket, which reads their reach again. */
  ROLE_CHANGED: 4409,
  /** The person is no longer a member of the item's workspace — the client must NOT reconnect. */
  MEMBERSHIP_ENDED: 4410,
} as const;

/**
 * The text schema a page's editor holds, sent on `/ws/:docId` as `schema`: the document store version
 * that brought in the node and mark types a document's text may hold now (doc-actor's store-version
 * test pins the two together). A page that sends an older one, or none, is closed with DOC_RESET
 * before it syncs, so it reloads into the current build: its editor would delete, for everyone, the
 * nodes it cannot read.
 */
export const TEXT_SCHEMA_VERSION = 3;

/**
 * Keepalive STRING messages: the client sends PING on a timer and the actor
 * host answers PONG without dispatching to the actor. Binary handlers ignore
 * strings, so these cannot collide with the opcode table.
 */
export const Heartbeat = {
  PING: "ping",
  PONG: "pong",
} as const;

/** Payload of DOC_STATE. */
export interface DocStatePayload {
  locked: boolean;
  /** In the trash: no one may write until it is restored. */
  trashed: boolean;
  /** This socket's write tier, apart from the lock and the trash. */
  can_write: boolean;
}

/** Payload of TITLE_CHANGED. */
export interface TitleChangedPayload {
  title: string;
  /** The name of the person who renamed it. */
  by: string;
}

/** Payload of DOC_RESET when a person restored a version; a reset for any other reason has none. */
export interface DocResetPayload {
  restored: {
    /** The name of the person who restored it. */
    by: string;
    /** When the restored version was saved, as an ISO string. */
    at: string;
    /** The restored version's seq. */
    seq: number;
  };
}

export interface PersistDegradedPayload {
  /** True on entering the degraded state, false when a flush succeeds again. */
  degraded: boolean;
}

/** Reasons a server may refuse a write (the payload of WRITE_REJECTED). */
export type WriteRejectedKind =
  | "acl"
  | "locked"
  /** The document is in the trash. */
  | "trashed"
  | "table-cap"
  | "structural-rate"
  | "rate-limit"
  /** The socket never acknowledged the current DOCUMENT_EPOCH; it is closed with DOC_RESET. */
  | "epoch"
  /** Agent sockets may not write raw Yjs; agent edits go through the propose API. */
  | "approval_required";
