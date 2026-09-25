/**
 * Applies the migrations a database has not seen, in order, in one transaction
 * under an advisory lock, so a second node starting at once finds the work done.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { EMBEDDING_DIMS, MAX_EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import type { Sql } from "../client.js";
import type { Queryable } from "../sql.js";

/**
 * Migration filenames in apply order. Explicit, so a stray file cannot change
 * what runs. Append only: an applied file is frozen by its checksum.
 */
export const MIGRATIONS: readonly string[] = ["0001_initial.sql", "0002_oauth_grants.sql"];

/** `0007_foo.sql` → 7. Throws on a filename that is not numbered. */
export function migrationId(filename: string): number {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(filename);
  if (!match) {
    throw new Error(
      `migration "${filename}" is not named NNNN_lower_snake_case.sql — the number is its identity and the order it runs in`,
    );
  }
  return Number(match[1]);
}

/** Ids in order, having verified they start at 1 and are contiguous. */
export function checkedIds(): number[] {
  const ids = MIGRATIONS.map(migrationId);
  ids.forEach((id, index) => {
    if (id !== index + 1) {
      throw new Error(
        `migration list is not contiguous: expected ${String(index + 1).padStart(4, "0")} at position ${index}, got ${MIGRATIONS[index]}. ` +
          `Numbers are the apply order and the schema version; a gap makes "schema 7" mean different things on different nodes.`,
      );
    }
  });
  return ids;
}

/** The schema version this build expects: the highest migration it carries. */
export const SCHEMA_VERSION: number = checkedIds().at(-1) ?? 0;

/** Any fixed value, the same for every node. */
const MIGRATION_LOCK = 487_230_199_577;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Interpolated into DDL text.
function assertEmbeddingDims(embeddingDims: number): void {
  if (!Number.isInteger(embeddingDims) || embeddingDims < 1 || embeddingDims > MAX_EMBEDDING_DIMS) {
    throw new Error(`migrate: embeddingDims must be an integer in 1..${MAX_EMBEDDING_DIMS}, got ${String(embeddingDims)}`);
  }
}

function checksum(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
}

/** The highest migration recorded in this database; 0 when none has run. */
export async function readSchemaVersion(sql: Queryable): Promise<number> {
  const [registry] = await sql<{ present: boolean }[]>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`;
  if (!registry?.present) return 0;
  const [row] = await sql<{ version: number }[]>`SELECT COALESCE(max(id), 0)::int AS version FROM schema_migrations`;
  return row?.version ?? 0;
}

export interface MigrationOutcome {
  /** Schema version before the run; 0 for a fresh database. */
  from: number;
  /** Schema version now; SCHEMA_VERSION on success. */
  to: number;
  /** Filenames applied by this run, in order. */
  applied: string[];
}

/**
 * Bring `sql` up to SCHEMA_VERSION. A current database is read, not written.
 *
 * `embeddingDims` sets the width of doc_chunks.embedding on a fresh database
 * only. Throws when the database was written by a newer build, or when an
 * applied migration file has been edited since it ran.
 */
export async function initSchema(sql: Sql, opts: { embeddingDims?: number } = {}): Promise<MigrationOutcome> {
  const embeddingDims = opts.embeddingDims ?? EMBEDDING_DIMS;
  checkedIds();
  assertEmbeddingDims(embeddingDims);

  const files = await Promise.all(
    MIGRATIONS.map(async (name) => {
      const raw = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      return { name, id: migrationId(name), raw, sum: checksum(raw) };
    }),
  );

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;

    const [registry] = await tx<{ present: boolean }[]>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`;
    if (!registry?.present) {
      await tx`
        CREATE TABLE schema_migrations (
            id          INTEGER PRIMARY KEY,
            filename    TEXT NOT NULL,
            checksum    TEXT NOT NULL,
            applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
    }

    const rows = await tx<{ id: number; filename: string; checksum: string }[]>`
      SELECT id, filename, checksum FROM schema_migrations ORDER BY id`;
    const applied = new Map(rows.map((r) => [r.id, r]));
    const from = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.id));

    if (from > SCHEMA_VERSION) {
      throw new Error(
        `this database is at schema ${from}, but this build of Stuga only knows schema ${SCHEMA_VERSION}. ` +
          `It was written by a NEWER version, which may have changed what these tables mean — running against it could corrupt data. ` +
          `Start the newer version again, or restore the backup you took before upgrading.`,
      );
    }

    for (const file of files) {
      const already = applied.get(file.id);
      if (already) {
        if (already.checksum !== file.sum) {
          throw new Error(
            `migration ${file.name} has been edited since it ran on this database (recorded ${already.checksum}, file is now ${file.sum}). ` +
              `Applied migrations are frozen: editing one changes what a fresh install gets while leaving every existing database untouched. ` +
              `Revert the file and put the change in a new numbered migration.`,
          );
        }
        continue;
      }
      await tx.unsafe(file.raw.replaceAll("@EMBEDDING_DIMS@", String(embeddingDims)));
      await tx`
        INSERT INTO schema_migrations (id, filename, checksum)
        VALUES (${file.id}, ${file.name}, ${file.sum})`;
    }

    return {
      from,
      to: SCHEMA_VERSION,
      applied: files.filter((f) => !applied.has(f.id)).map((f) => f.name),
    };
  }) as Promise<MigrationOutcome>;
}
