/**
 * Agent SQL runs inside a transaction that always rolls back, so a write that
 * slips past the static select-only scan evaporates. Rows stream one at a time,
 * so the caps and the deadline stop a query mid-result; nothing bounds the wait
 * for the first row (node:sqlite has no interrupt), which is why the scan also
 * refuses row sources with size but no data.
 */
import { DATABASE_QUERY_MAX_ROWS } from "@stuga/protocol/databases/limits";
import type { ActorStorage } from "@stuga/runtime";

/** Ceiling on one value; a single cell (`randomblob(n)`) can be unbounded with one row. */
export const DATABASE_QUERY_MAX_VALUE_BYTES = 1_000_000;

/** Ceiling on a whole result: the row and value caps alone still multiply to gigabytes. */
const DATABASE_QUERY_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** How long a query may spend producing rows. */
const DATABASE_QUERY_DEADLINE_MS = 5_000;

interface ReadOnlyResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

const ROLLBACK = Symbol("rollback");

function valueBytes(v: unknown): number {
  if (typeof v === "string") return Buffer.byteLength(v, "utf8");
  if (v instanceof Uint8Array) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  return 0;
}

/** Overrides for tests, so caps and the deadline can be proven without real volumes or waits. */
interface ReadLimits {
  maxRows?: number;
  maxValueBytes?: number;
  maxTotalBytes?: number;
  deadlineMs?: number;
  now?: () => number;
}

/**
 * Run one query and roll back. SQL errors propagate (the route answers 400); a
 * row cap or the aggregate byte cap truncates, while an oversized value or the
 * deadline throws.
 */
export function runReadOnly(storage: Pick<ActorStorage, "sql" | "transactionSync">, query: string, params: unknown[], limits: ReadLimits = {}): ReadOnlyResult {
  const maxRows = limits.maxRows ?? DATABASE_QUERY_MAX_ROWS;
  const maxValueBytes = limits.maxValueBytes ?? DATABASE_QUERY_MAX_VALUE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DATABASE_QUERY_MAX_TOTAL_BYTES;
  const deadlineMs = limits.deadlineMs ?? DATABASE_QUERY_DEADLINE_MS;
  const now = limits.now ?? Date.now;

  let out: ReadOnlyResult = { columns: [], rows: [], truncated: false };
  const startedAt = now();
  try {
    storage.transactionSync(() => {
      // The stream belongs to the transaction, so rows are collected inside it.
      const stream = storage.sql.iterate(query, ...params);
      const rows: Record<string, unknown>[] = [];
      let truncated = false;
      let totalBytes = 0;
      for (const row of stream.rows) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        if (now() - startedAt > deadlineMs) {
          throw new Error(
            `query took longer than ${Math.round(deadlineMs / 1000)}s and was stopped after ${rows.length} row(s). ` +
              `Narrow it with a WHERE clause, or select fewer joined tables`,
          );
        }
        let rowBytes = 0;
        for (const [column, value] of Object.entries(row)) {
          const bytes = valueBytes(value);
          if (bytes > maxValueBytes) {
            throw new Error(`value in column "${column}" is ${bytes} bytes, over the ${maxValueBytes}-byte limit for a single value`);
          }
          rowBytes += bytes;
        }
        if (totalBytes + rowBytes > maxTotalBytes) {
          truncated = true;
          break;
        }
        totalBytes += rowBytes;
        rows.push(row);
      }
      const first = rows[0];
      out = { columns: stream.columnNames.length ? stream.columnNames : first ? Object.keys(first) : [], rows, truncated };
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out;
}
