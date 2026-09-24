/**
 * MANIFEST.json: what a backup is, and the commit marker that says it is whole.
 * It is written last, after both halves were read back, inside `<name>.partial`,
 * which is then renamed into place; a directory without a parsing manifest is
 * never restored from or counted.
 *
 *   created_at            the instant the node was proven stopped; orders retention.
 *   database              the source database; retention only touches its own.
 *   stuga_version         the last build that booted on this data.
 *   runtime_version       the build that took the backup.
 *   schema_version        a restore refuses a backup newer than its runtime.
 *   postgres_version_num  a custom-format dump restores only into its own major.
 *   embedding_dims        checked before a restore, since a node refuses another width.
 *   public_origin         the issuer of every session token in the backup.
 *   database_bytes, data_dir_bytes  the room a restore needs.
 *   files                 sha256 and size of each half, checked before a restore.
 */
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { refused } from "./outcome.js";

export const MANIFEST_FORMAT = 1;
export const MANIFEST_NAME = "MANIFEST.json";
export const DUMP_NAME = "postgres.dump";
export const ARCHIVE_NAME = "data.tar.gz";

export interface FileEntry {
  sha256: string;
  bytes: number;
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  created_at: string;
  database: string;
  stuga_version: string | null;
  runtime_version: string;
  schema_version: number;
  postgres_version_num: number;
  extensions: Record<string, string>;
  embedding_dims: number | null;
  search_languages: string[];
  public_origin: string;
  database_bytes: number;
  data_dir_bytes: number;
  files: { [DUMP_NAME]: FileEntry; [ARCHIVE_NAME]: FileEntry };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const isFile = (v: unknown): v is FileEntry =>
  !!v && typeof v === "object" && /^[0-9a-f]{64}$/.test((v as FileEntry).sha256) && isInt((v as FileEntry).bytes);

/** Parse and validate a manifest; a refusal names the first thing wrong with it. */
function parseManifest(text: string, where: string): Manifest {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw refused(`${where} is not valid JSON — this is not a backup this tool made, or it is damaged`);
  }
  const bad = (field: string) => refused(`${where}: "${field}" is missing or malformed — this backup cannot be trusted`);
  if (m.format !== MANIFEST_FORMAT) {
    throw refused(`${where} has format ${JSON.stringify(m.format)}; this runtime reads format ${MANIFEST_FORMAT}`);
  }
  if (!isStr(m.created_at) || Number.isNaN(Date.parse(m.created_at))) throw bad("created_at");
  if (!isStr(m.database) || m.database === "") throw bad("database");
  if (m.stuga_version !== null && !isStr(m.stuga_version)) throw bad("stuga_version");
  if (!isStr(m.runtime_version)) throw bad("runtime_version");
  if (!isInt(m.schema_version)) throw bad("schema_version");
  if (!isInt(m.postgres_version_num) || m.postgres_version_num === 0) throw bad("postgres_version_num");
  if (!m.extensions || typeof m.extensions !== "object" || Object.values(m.extensions).some((v) => !isStr(v))) {
    throw bad("extensions");
  }
  if (m.embedding_dims !== null && !isInt(m.embedding_dims)) throw bad("embedding_dims");
  if (!Array.isArray(m.search_languages) || !m.search_languages.every(isStr)) throw bad("search_languages");
  if (!isStr(m.public_origin)) throw bad("public_origin");
  if (!isInt(m.database_bytes)) throw bad("database_bytes");
  if (!isInt(m.data_dir_bytes)) throw bad("data_dir_bytes");
  const files = m.files as Record<string, unknown> | undefined;
  if (!files || !isFile(files[DUMP_NAME]) || !isFile(files[ARCHIVE_NAME])) throw bad("files");
  return m as unknown as Manifest;
}

export async function readManifest(dir: string): Promise<Manifest> {
  const path = join(dir, MANIFEST_NAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw refused(`${dir} has no ${MANIFEST_NAME} — it is not a complete backup this tool made`);
    }
    throw err;
  }
  return parseManifest(text, path);
}

/** Write the manifest so that it either exists whole or not at all. */
export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const final = join(dir, MANIFEST_NAME);
  const temp = `${final}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, final);
  await syncDirectory(dir);
}

/** fsync a directory, so a rename inside it survives a power cut. */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
