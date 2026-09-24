/**
 * What the node checks about its Postgres before it agrees to run. The decisions
 * are pure functions of what the server reports; the `assert*` wrappers query and throw.
 */
import { preloadsPgSearch, type Sql } from "@stuga/db";
import { ConfigError } from "../config/env.js";

/**
 * The Postgres major this node is built against, as server_version_num
 * (18.6 → 180006): the pg_search and pgvector binaries it ships with are built
 * for this major only.
 */
export const PG_MIN = 180000;
export const PG_MAX_EXCLUSIVE = 190000;

function majorOf(serverVersionNum: number): number {
  return Math.floor(serverVersionNum / 10000);
}

/** Null when this server is supported, otherwise the message the operator sees. */
export function postgresVersionProblem(serverVersionNum: number): string | null {
  if (serverVersionNum >= PG_MIN && serverVersionNum < PG_MAX_EXCLUSIVE) return null;
  const found = majorOf(serverVersionNum);
  const want = majorOf(PG_MIN);
  return (
    `this node is built for Postgres ${want}, but the server it connected to is Postgres ${found}. ` +
    (found > want
      ? `This node has written nothing: upgrade Stuga to a release built for Postgres ${found}.`
      : `This node has written nothing, and a Postgres major does not change in place: dump the database with ` +
        `the Postgres ${found} that wrote it, then restore into Postgres ${want}.`)
  );
}

/**
 * Null when this database can serve search (every keyword leg is a BM25 query),
 * otherwise the message the operator sees. `available`, not `installed`: the
 * migration creates the extension after this runs. `preloaded` is null when the
 * role may not read the setting, which is not reported as a problem.
 */
export function pgSearchProblem(db: { available: boolean; preloaded: boolean | null }): string | null {
  const want = majorOf(PG_MIN);
  if (!db.available) {
    return (
      `this Postgres does not offer the pg_search extension — it is not in pg_available_extensions, so the ` +
      `node cannot create it, and every search runs through it. Install pg_search built for Postgres ${want} ` +
      `on this server, list pg_search in its shared_preload_libraries, and restart Postgres. This node has ` +
      `written nothing.`
    );
  }
  if (db.preloaded === false) {
    return (
      `this Postgres offers the pg_search extension, but does not load it: pg_search is missing from ` +
      `shared_preload_libraries. Add it to that setting in postgresql.conf, keeping any library already listed, ` +
      `and restart Postgres — a running server cannot load it, which is why this is a boot error and not a warning.`
    );
  }
  return null;
}

/** The builtin-provider locale every Stuga database is created with, on every platform. */
export const BUILTIN_LOCALE = "C.UTF-8";

/** One row of pg_database: `provider` is datlocprovider (`b`, `c` or `i`). */
export interface DatabaseLocale {
  provider: string;
  locale: string | null;
  collate: string;
}

/**
 * Null when this database sorts and compares text the way every other Stuga
 * database does, otherwise the message the operator sees. A database's default
 * collation is fixed when it is created, so nothing short of a new database changes it.
 */
export function databaseLocaleProblem(db: DatabaseLocale): string | null {
  if (db.provider === "b" && db.locale === BUILTIN_LOCALE) return null;
  const found =
    db.provider === "b"
      ? `the builtin provider's "${db.locale ?? ""}"`
      : db.provider === "i"
        ? `the ICU locale "${db.locale ?? ""}"`
        : `the operating system's "${db.collate}"`;
  return (
    `this database's default collation is ${found}, but Stuga databases use the builtin provider's ` +
    `${BUILTIN_LOCALE}, so text orders and compares the same on every node. A database keeps the ` +
    `collation it was created with. This node has written nothing. Create the database in a cluster initialised ` +
    `with initdb --locale-provider=builtin --builtin-locale=${BUILTIN_LOCALE}, or with CREATE DATABASE ` +
    `… LOCALE_PROVIDER builtin BUILTIN_LOCALE '${BUILTIN_LOCALE}' TEMPLATE template0; a backup restores into either.`
  );
}

/** Read the current database's locale and refuse to run on one created with another collation. */
export async function assertDatabaseLocale(sql: Sql): Promise<void> {
  const rows = await sql<DatabaseLocale[]>`
    SELECT datlocprovider::text AS provider, datlocale AS locale, datcollate AS collate
    FROM pg_database WHERE datname = current_database()`;
  const row = rows[0];
  if (!row) throw new ConfigError("could not read this database's locale from pg_database");
  const problem = databaseLocaleProblem(row);
  if (problem) throw new ConfigError(problem);
}

/** Read the catalog and the preload setting, and refuse to run on a server that cannot serve search. */
export async function assertPgSearch(sql: Sql): Promise<void> {
  const rows = await sql<{ available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search') AS available`;
  const available = rows[0]?.available === true;
  // The column SHOW returns is named after the setting.
  const preloaded = await sql<{ shared_preload_libraries?: string }[]>`SHOW shared_preload_libraries`
    .then((r) => {
      const setting = r[0]?.shared_preload_libraries;
      return typeof setting === "string" ? preloadsPgSearch(setting) : null;
    })
    .catch(() => null);
  const problem = pgSearchProblem({ available, preloaded });
  if (problem) throw new ConfigError(problem);
}

/** Query the server version and refuse to run on an unsupported major. */
export async function assertPostgresVersion(sql: Sql): Promise<number> {
  const rows = await sql<{ server_version_num: string }[]>`SHOW server_version_num`;
  const num = Number(rows[0]?.server_version_num);
  if (!Number.isFinite(num)) {
    throw new ConfigError("could not read the Postgres server version — the connection works but the server is not answering SHOW server_version_num");
  }
  const problem = postgresVersionProblem(num);
  if (problem) throw new ConfigError(problem);
  return num;
}
