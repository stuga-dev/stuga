/**
 * stuga-node verify: is this backup whole, and can this runtime restore it?
 * Whole: the manifest parses, each half matches its recorded size and sha256,
 * the dump reads back through pg_restore and the archive through tar.
 * Restorable here: the Postgres major matches this runtime and the server, the
 * schema is not newer than this runtime's, and the embedding width matches the
 * node's. Verify only reads; a restore runs all of it first.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@stuga/db";
import { PG_MAX_EXCLUSIVE, PG_MIN } from "../boot/preflight.js";
import type { BackupEnv } from "./env.js";
import { sessionConnection } from "../writer-lock.js";
import { ARCHIVE_NAME, DUMP_NAME, readManifest, type Manifest } from "./manifest.js";
import { messageOf, refused, throwIfInterrupted } from "./outcome.js";
import { listArchive, pgTool, run, sha256File } from "./tools.js";

export interface VerifyResult {
  path: string;
  manifest: Manifest;
  /** Facts a restore should say out loud, e.g. that the schema will migrate. */
  notes: string[];
}

const major = (versionNum: number): number => Math.floor(versionNum / 10000);

/** The whole-and-readable half. Refuses with the first thing that is wrong. */
export async function verifyIntegrity(env: BackupEnv, dir: string, signal?: AbortSignal): Promise<Manifest> {
  const manifest = await readManifest(dir);
  for (const name of [DUMP_NAME, ARCHIVE_NAME] as const) {
    const path = join(dir, name);
    const expected = manifest.files[name];
    const size = await stat(path).then(
      (s) => s.size,
      () => null,
    );
    if (size === null) throw refused(`${path} is missing — this backup is incomplete; nothing was changed`);
    if (size !== expected.bytes) {
      throw refused(`${path} is ${size} bytes, the manifest says ${expected.bytes} — this backup is damaged; nothing was changed`);
    }
    if ((await sha256File(path)).sha256 !== expected.sha256) {
      throw refused(`${path} does not match its checksum — this backup is damaged; nothing was changed`);
    }
  }
  try {
    await run(pgTool(env, "pg_restore"), ["--file=/dev/null", join(dir, DUMP_NAME)], { signal });
  } catch (err) {
    throwIfInterrupted(signal, "nothing was changed");
    throw refused(`${join(dir, DUMP_NAME)} does not read back (${messageOf(err)}); nothing was changed`);
  }
  try {
    const listing = await listArchive(join(dir, ARCHIVE_NAME), signal);
    if (listing.first !== "./") throw new Error(`first member is ${JSON.stringify(listing.first)}, not ./`);
  } catch (err) {
    throwIfInterrupted(signal, "nothing was changed");
    throw refused(`${join(dir, ARCHIVE_NAME)} does not read back (${messageOf(err)}); nothing was changed`);
  }
  return manifest;
}

/**
 * The restorable-here half, against this runtime and (when given) the server's
 * own version. Returns notes; refuses on anything that would fail after a
 * restore had already replaced the current data.
 */
export function checkCompatibility(env: BackupEnv, manifest: Manifest, serverVersionNum: number | null): string[] {
  const notes: string[] = [];
  const want = major(PG_MIN);
  if (manifest.postgres_version_num < PG_MIN || manifest.postgres_version_num >= PG_MAX_EXCLUSIVE) {
    throw refused(
      `this backup came from Postgres ${major(manifest.postgres_version_num)} and this runtime is built for Postgres ${want}. ` +
        `A dump restores into the major that wrote it; nothing was changed.`,
    );
  }
  if (serverVersionNum !== null && major(serverVersionNum) !== major(manifest.postgres_version_num)) {
    throw refused(
      `this backup came from Postgres ${major(manifest.postgres_version_num)} and the server is Postgres ${major(serverVersionNum)}; ` +
        `nothing was changed`,
    );
  }
  if (manifest.schema_version > SCHEMA_VERSION) {
    throw refused(
      `this backup is at schema ${manifest.schema_version}, written by Stuga ${manifest.stuga_version ?? manifest.runtime_version}; ` +
        `this runtime only knows schema ${SCHEMA_VERSION}. Restore it with the runtime that took it. Nothing was changed.`,
    );
  }
  if (manifest.schema_version < SCHEMA_VERSION) {
    notes.push(`the backup is at schema ${manifest.schema_version}; the node migrates it to schema ${SCHEMA_VERSION} when it starts`);
  }
  if (manifest.embedding_dims !== null && manifest.embedding_dims !== env.embeddingDims) {
    throw refused(
      `this backup stores embeddings of width ${manifest.embedding_dims} and the node is configured for ${env.embeddingDims} ` +
        `(AI_EMBED_DIMS); the node would refuse to start on it. Set AI_EMBED_DIMS=${manifest.embedding_dims} first. Nothing was changed.`,
    );
  }
  if (manifest.public_origin !== env.publicOrigin) {
    notes.push(
      `the backup's sessions were issued for ${manifest.public_origin} and this node is ${env.publicOrigin}; ` +
        `people will have to sign in again`,
    );
  }
  return notes;
}

export async function runVerify(env: BackupEnv, dir: string): Promise<VerifyResult> {
  const manifest = await verifyIntegrity(env, dir);
  // Everything else is still checked when the server does not answer.
  const sql = sessionConnection(env.databaseUrl, "postgres");
  const serverVersionNum = await sql<{ v: string }[]>`SELECT current_setting('server_version_num') AS v`
    .then((rows) => Number(rows[0]!.v))
    .catch(() => null)
    .finally(() => sql.end({ timeout: 5 }).catch(() => {}));
  const notes = checkCompatibility(env, manifest, serverVersionNum);
  if (serverVersionNum === null) notes.push("the server did not answer; its major was not compared");
  return { path: dir, manifest, notes };
}
