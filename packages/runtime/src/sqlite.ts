/**
 * The SQL half of actor storage, over `node:sqlite`, shared by the file-backed
 * host and the in-memory test host so both enforce the same rules:
 *
 *   - boolean and undefined bindings throw, so an un-normalised value never
 *     reaches SQLite's silent coercion;
 *   - numbers bind as REAL, so code must not key logic on 'integer' vs 'real';
 *   - `transactionSync` nests through savepoints.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ActorSql, SqlCursor, SqlStream } from "./interfaces.js";

export class SqliteCursor implements SqlCursor {
  constructor(
    private readonly rows: Record<string, unknown>[],
    readonly columnNames: string[],
  ) {}

  toArray(): Record<string, unknown>[] {
    return this.rows;
  }

  one(): Record<string, unknown> {
    if (this.rows.length !== 1) throw new Error(`one(): expected exactly 1 row, got ${this.rows.length}`);
    return this.rows[0]!;
  }

  *[Symbol.iterator](): IterableIterator<Record<string, unknown>> {
    yield* this.rows;
  }
}

function bindable(value: unknown, index: number): SQLInputValue {
  if (typeof value === "boolean" || value === undefined) {
    throw new TypeError(`Provided value cannot be bound to SQLite parameter ${index + 1}.`);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  if (ArrayBuffer.isView(value)) return value as NodeJS.ArrayBufferView;
  throw new TypeError(`Provided value cannot be bound to SQLite parameter ${index + 1}.`);
}

export class SqliteActorSql implements ActorSql {
  constructor(private readonly db: DatabaseSync) {}

  exec(query: string, ...bindings: unknown[]): SqliteCursor {
    const params = bindings.map(bindable);
    const stmt = this.db.prepare(query);
    let columnNames: string[] = [];
    try {
      columnNames = stmt.columns().map((c) => c.name);
    } catch {
      columnNames = []; // statements that return no data have no columns
    }
    let rows: Record<string, unknown>[];
    try {
      rows = stmt.all(...params);
    } catch (e) {
      // Only the "returns no data" refusal falls back to `.run()`: a real SQL
      // error must propagate, not execute twice.
      if (e instanceof Error && /does not return data|run\(\) instead/i.test(e.message)) {
        stmt.run(...params);
        rows = [];
      } else {
        throw e;
      }
    }
    return new SqliteCursor(rows, columnNames);
  }

  iterate(query: string, ...bindings: unknown[]): SqlStream {
    const params = bindings.map(bindable);
    const stmt = this.db.prepare(query);
    let columnNames: string[] = [];
    try {
      columnNames = stmt.columns().map((c) => c.name);
    } catch {
      columnNames = [];
    }
    // No .run() fallback: callers only stream SELECTs the SQL guard admitted.
    return { columnNames, rows: stmt.iterate(...params) as IterableIterator<Record<string, unknown>> };
  }
}

/** Savepoint-nested transactions: commit on return, roll back on throw. */
export class SavepointTransactions {
  private depth = 0;
  constructor(private readonly db: DatabaseSync) {}

  run<T>(fn: () => T): T {
    const name = `_txn_${this.depth++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
}

/** Drop every table and view except SQLite's own and the ones in `keep`. */
export function dropUserObjects(db: DatabaseSync, keep: string[] = []): void {
  const rows = db
    .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
    .all() as Array<{ name: string; type: string }>;
  // Views first, so no view is ever left pointing at a dropped table.
  for (const { name } of rows.filter((r) => r.type === "view")) {
    if (!keep.includes(name)) db.exec(`DROP VIEW IF EXISTS "${name.replaceAll('"', '""')}"`);
  }
  for (const { name } of rows.filter((r) => r.type === "table")) {
    if (!keep.includes(name)) db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
  }
}
