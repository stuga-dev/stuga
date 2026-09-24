/** JSON files under the data directory, written through a temp file so a crash never leaves a truncated one. */
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomHex } from "../crypto.js";

/** Parse a JSON file, or return null when it does not exist. */
export async function readJsonFile(path: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(text) as unknown;
}

async function writeTemp(path: string, value: unknown, mode: number): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomHex(6)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode, flag: "wx" });
  return tmp;
}

/**
 * Create `path` only if nothing is there yet; false when another writer got
 * there first. link() makes check-and-create atomic, so racing boots share one key.
 */
export async function writeJsonFileExclusive(path: string, value: unknown, mode = 0o644): Promise<boolean> {
  const tmp = await writeTemp(path, value, mode);
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
