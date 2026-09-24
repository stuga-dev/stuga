/** Structured-database limits (distinct from domain/limits' MAX_TABLE_*, which cap tables inside prose). */

export const DATABASE_MAX_TABLES = 20;
export const DATABASE_MAX_COLUMNS = 64;
export const DATABASE_MAX_ROWS = 50_000;
/** One text cell, in UTF-8 bytes. */
export const DATABASE_MAX_CELL_BYTES = 16_384;
/** Rows per insert/update/delete batch. */
export const DATABASE_MAX_ROWS_PER_WRITE = 500;
/** Grid page window for /rows/list. */
export const DATABASE_ROWS_PAGE_MAX = 200;
/** Leaves (conditions) one filter tree may hold, and how deep its groups nest. */
export const DATABASE_FILTER_MAX_LEAVES = 20;
export const DATABASE_FILTER_MAX_DEPTH = 3;
/** Sort keys one listing or view may carry. */
export const DATABASE_MAX_SORTS = 4;
/** Groups a grouped listing reports before it says `groups_truncated`. */
export const DATABASE_MAX_GROUPS = 200;
/** Saved views per table. */
export const DATABASE_MAX_VIEWS = 20;
/** Agent SQL text, in UTF-8 bytes. */
export const DATABASE_QUERY_MAX_BYTES = 8_192;
/** Agent SELECT result cap; responses set `truncated: true` beyond it. */
export const DATABASE_QUERY_MAX_ROWS = 1_000;
/** Rows of a query result the ask agent's model is shown. */
export const DATABASE_ASK_QUERY_MAX_ROWS = 200;
/** Ledger retention: oldest ops beyond this are pruned (and their blob spills deleted). */
export const DATABASE_OPS_KEEP = 500;
/** Largest table (rows) whose delete still captures a revert inverse; above it the op is non-revertible. */
export const DATABASE_REVERT_MAX_ROWS = 5_000;
/** Inverse payloads above this spill to the blob store instead of the _ops row. */
export const DATABASE_OP_INLINE_MAX_BYTES = 64 * 1024;
/** Per-principal sliding-window rate limits, enforced in the actor. */
export const DATABASE_MUTATIONS_PER_MINUTE = 120;
export const DATABASE_QUERIES_PER_MINUTE = 60;
/** Run-ledger retention: oldest runs beyond this are pruned (with their blob spills). */
export const DATABASE_RUN_KEEP = 50;
/** Max pending ops one run may accumulate; beyond it propose is refused. */
export const DATABASE_RUN_OPS_MAX = 200;
/** Above this total payload size a run summary elides op payloads (`ops_truncated`). */
export const DATABASE_RUN_WIRE_MAX_BYTES = 256 * 1024;
/** Run payloads above this spill to the blob store instead of the _run_ops row. */
export const DATABASE_RUN_INLINE_MAX_BYTES = 64 * 1024;
/** Default run-list page. */
export const DATABASE_RUN_LIST_DEFAULT = 20;

/** Largest staged file. The node's body ceiling may be lower; the ticket says which. */
export const DATABASE_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
/** How long a staged (uncommitted) import stays uploadable and committable. */
export const DATABASE_IMPORT_TTL_MS = 60 * 60 * 1000;
/** Row-level errors reported per commit; `errors_truncated` says when more were found. */
export const DATABASE_IMPORT_MAX_ERRORS = 100;
/** Inline import text (`import` with `content`), in characters; larger files go through the Import dialog. */
export const DATABASE_IMPORT_INLINE_MAX_CHARS = 1_000_000;

/** Display names (tables, columns, select choices). */
export const DATABASE_MAX_DISPLAY_LENGTH = 200;
/** A column's description: help text, not documentation. */
export const DATABASE_MAX_COLUMN_DESCRIPTION_CHARS = 500;
export const DATABASE_MAX_SELECT_CHOICES = 50;
