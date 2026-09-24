/**
 * Snapshot retention. A snapshot at `seq` is retained iff it is within the last
 * SNAPSHOT_KEEP of HEAD, one of the last VERSION_KEEP recorded versions
 * (`seq >= docs.version_floor` in SQL), or a milestone (`seq % SNAPSHOT_MILESTONE === 0`).
 * The actor's prune and every query that offers a version must apply the same
 * three clauses, so an offered version always has bytes behind it.
 */
export const SNAPSHOT_KEEP = 20;
export const SNAPSHOT_MILESTONE = 50;
/** Recorded versions a document keeps. Versions are recorded on a time cadence, not per flush. */
export const VERSION_KEEP = 20;

/** Longest an accepted edit waits for the document actor's snapshot, which indexing and a derived title follow. */
export const DOC_FLUSH_INTERVAL_MS = 30_000;

/** Blob key of a document's snapshot at `seq`. Always derived; never read back from `versions.blob_key`. */
export function snapshotKey(docId: string, seq: number): string {
  return `${docId}/${seq}.bin`;
}

/**
 * Default embedding width for a fresh install. The live width is the
 * `vector(N)` column's, read at boot; validate vectors against that, never
 * against this constant.
 */
export const EMBEDDING_DIMS = 1024;

/** Widest embedding the schema can hold: pgvector's HNSW index refuses a `vector` column wider than this. */
export const MAX_EMBEDDING_DIMS = 2000;

/**
 * Table growth ceilings enforced by the document actor. They bound the
 * fixTables padding feedback loop between peers, which any client can drive
 * even when the editor's own guard is present. A table past these is a bug.
 */
export const MAX_TABLE_COLS = 64;
export const MAX_TABLE_ROWS = 1000;
/** Table-growing updates one connection may send per rate window. */
export const MAX_TABLE_GROWTH_PER_WINDOW = 60;

/** How long an open agent run (document or database) may go quiet before the next propose starts a new one. */
export const RUN_IDLE_MS = 600_000;

/** Days a trashed document stays restorable before maintenance deletes it. */
export const TRASH_RETENTION_DAYS = 30;

/** The most documents one library listing returns. */
export const LIBRARY_LIST_CAP = 200;

/** Longest workspace "Instructions for agents" text. */
export const MAX_AGENT_INSTRUCTIONS_CHARS = 20_000;
