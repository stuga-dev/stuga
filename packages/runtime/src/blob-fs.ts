/**
 * Blob storage on the local file system.
 *
 * A key such as `media/ws_1/ab12` becomes `dir/media/ws_1/ab12.blob`; every
 * path segment is percent-encoded so a key can never escape `dir` or collide
 * with the `.blob.meta.json` sidecar that carries `httpMetadata`. Both files are
 * written to a temporary name and renamed into place, sidecar first, so a new
 * object is never visible without its metadata and neither file is ever seen
 * half-written. Listing walks the directory the prefix pins down and pages with
 * an opaque cursor (the last key returned).
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import type { BlobHead, BlobList, BlobMetadata, BlobObject, BlobStore } from "./interfaces.js";

const DATA_SUFFIX = ".blob";
const META_SUFFIX = ".blob.meta.json";
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function encodeSegment(segment: string): string {
  if (SAFE_SEGMENT.test(segment)) return segment;
  let out = "";
  for (const ch of segment) {
    if (ch.length === 1 && /[A-Za-z0-9_-]/.test(ch)) out += ch;
    else for (const b of Buffer.from(ch, "utf8")) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out === "" ? "%" : out; // an empty segment ("a//b") still needs a name
}

function decodeSegment(segment: string): string {
  return segment === "%" ? "" : decodeURIComponent(segment);
}

function keyToPath(dir: string, key: string): string {
  return join(dir, ...key.split("/").map(encodeSegment)) + DATA_SUFFIX;
}

function metaPathOf(dataPath: string): string {
  return dataPath.slice(0, -DATA_SUFFIX.length) + META_SUFFIX;
}

function tempPathOf(path: string): string {
  return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
}

/** Write `bytes` to `path` via a temporary file and a rename. */
async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = tempPathOf(path);
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

function pathToKey(dir: string, path: string): string {
  const rel = path.slice(dir.length).split(sep).filter((s) => s !== "");
  const last = rel.pop()!;
  rel.push(last.slice(0, -DATA_SUFFIX.length));
  return rel.map(decodeSegment).join("/");
}

interface Sidecar {
  httpMetadata?: BlobMetadata;
}

async function readSidecar(path: string): Promise<Sidecar | undefined> {
  try {
    return JSON.parse(await readFile(metaPathOf(path), "utf8")) as Sidecar;
  } catch {
    return undefined;
  }
}

async function headAt(key: string, path: string): Promise<BlobHead | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const meta = await readSidecar(path);
  const head: BlobHead = { key, size: st.size, uploaded: st.mtime };
  return meta?.httpMetadata ? { ...head, httpMetadata: meta.httpMetadata } : head;
}

/** Every `.blob` under `root` (recursively), as absolute paths. */
async function walk(root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (entry.isFile() && entry.name.endsWith(DATA_SUFFIX)) out.push(path);
  }
}

function encodeCursor(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

/** Remove now-empty parent directories up to (not including) `dir`. */
async function pruneEmptyDirs(dir: string, from: string): Promise<void> {
  let current = dirname(from);
  while (current.length > dir.length && current.startsWith(dir)) {
    try {
      await rmdir(current);
    } catch {
      return; // not empty, or already gone
    }
    current = dirname(current);
  }
}

export function fsBlobStore(dir: string): BlobStore {
  const root = join(dir);

  async function deleteOne(key: string): Promise<void> {
    const path = keyToPath(root, key);
    await rm(path, { force: true });
    await rm(metaPathOf(path), { force: true });
    await pruneEmptyDirs(root, path);
  }

  return {
    async head(key) {
      return headAt(key, keyToPath(root, key));
    },

    async get(key) {
      const path = keyToPath(root, key);
      const head = await headAt(key, path);
      if (!head) return null;
      const object: BlobObject = {
        ...head,
        get body() {
          return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
        },
        async arrayBuffer() {
          const buf = await readFile(path);
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        },
        async text() {
          return readFile(path, "utf8");
        },
      };
      return object;
    },

    async put(key, value, opts) {
      const path = keyToPath(root, key);
      await mkdir(dirname(path), { recursive: true });
      const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value instanceof Uint8Array ? value : new Uint8Array(value);
      const metaPath = metaPathOf(path);
      if (opts?.httpMetadata) {
        await writeAtomic(metaPath, JSON.stringify({ httpMetadata: opts.httpMetadata } satisfies Sidecar));
      } else {
        await rm(metaPath, { force: true });
      }
      await writeAtomic(path, bytes);
    },

    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) await deleteOne(k);
    },

    async list(opts = {}) {
      const prefix = opts.prefix ?? "";
      const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const after = opts.cursor ? decodeCursor(opts.cursor) : null;

      // Only the subtree the prefix pins down is walked: everything up to the
      // last "/" names directories that must match exactly.
      const cut = prefix.lastIndexOf("/");
      const fixedDirs = cut === -1 ? [] : prefix.slice(0, cut).split("/").map(encodeSegment);
      const paths: string[] = [];
      await walk(join(root, ...fixedDirs), paths);

      const keys = paths
        .map((p) => pathToKey(root, p))
        .filter((k) => k.startsWith(prefix) && (after === null || k > after))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const page = keys.slice(0, limit);
      const objects: BlobHead[] = [];
      for (const key of page) {
        const head = await headAt(key, keyToPath(root, key));
        if (head) objects.push(head);
      }
      const truncated = keys.length > limit;
      const result: BlobList = { objects, truncated };
      if (truncated) result.cursor = encodeCursor(page[page.length - 1]!);
      return result;
    },
  };
}
