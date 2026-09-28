/**
 * Image validation and the workspace-scoped media store. A browser upload, an
 * agent's base64 and a fetched URL all end in `storeImage`, which content-hashes
 * the bytes into `media/<workspaceId>/<hash>`.
 */
import { SAFE_IMAGE_MIMES, type SafeImageMime } from "@stuga/protocol/api/media";
import type { BlobStore } from "@stuga/runtime";
import { vetOutboundUrl } from "../net/outbound.js";

/** Multipart framing around the file part: boundary, headers, filename. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** The upload ceiling until an administrator changes the node setting. */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The largest upload an administrator may configure: the listener buffers whole bodies in memory. */
export const MAX_UPLOAD_BYTES_CEILING = 50 * 1024 * 1024;

/**
 * The request body an upload of `maxUploadBytes` needs once multipart-framed.
 * The body ceiling derives from this, so the media route, not the listener,
 * names the limit that stopped an upload.
 */
export const bodyBytesFor = (maxUploadBytes: number): number => maxUploadBytes + MULTIPART_OVERHEAD_BYTES;

/** The body ceiling a node runs with until an administrator says otherwise. */
export const DEFAULT_MAX_BODY_BYTES = bodyBytesFor(DEFAULT_MAX_UPLOAD_BYTES);

/** How a byte ceiling is named in the message a caller sees. */
const megabytes = (bytes: number): number => Math.floor(bytes / (1024 * 1024));

/** The upload ceiling in force, derived from the body ceiling so every message names the size enforced. */
export function imageUploadLimits(maxBodyBytes: number): {
  /** Largest image accepted, for `validateImageUpload`. */
  bytes: number;
  /** Largest multipart body worth reading, for the route's early check. */
  requestBytes: number;
  /** How both are named to the caller. */
  label: string;
} {
  const bytes = Math.max(0, maxBodyBytes - MULTIPART_OVERHEAD_BYTES);
  return { bytes, requestBytes: bodyBytesFor(bytes), label: `${megabytes(bytes)} MB` };
}

const SAFE_IMAGE_MIME: ReadonlySet<string> = new Set(SAFE_IMAGE_MIMES);

export class MediaValidationError extends Error {
  constructor(
    readonly status: 400 | 413 | 415 | 504,
    message: string,
  ) {
    super(message);
    this.name = "MediaValidationError";
  }
}

export function isSafeImageMime(value: string | undefined): value is SafeImageMime {
  return !!value && SAFE_IMAGE_MIME.has(value);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function matchesImageSignature(bytes: Uint8Array, mime: SafeImageMime): boolean {
  switch (mime) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return (
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );
    case "image/webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
      );
  }
}

export async function validateImageUpload(
  blob: Blob,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<{ bytes: Uint8Array; mime: SafeImageMime }> {
  const mime = blob.type.toLowerCase();
  if (!isSafeImageMime(mime)) throw new MediaValidationError(415, "unsupported image type");
  if (blob.size === 0) throw new MediaValidationError(400, "image is empty");
  // Before arrayBuffer(), so an oversized Blob is not copied a second time.
  if (blob.size > maxBytes) {
    throw new MediaValidationError(413, `image too large (max ${megabytes(maxBytes)} MB)`);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!matchesImageSignature(bytes, mime)) {
    throw new MediaValidationError(415, "image content does not match its declared type");
  }
  return { bytes, mime };
}

/** Redirect hops followed when fetching a remote image. */
const MAX_REMOTE_REDIRECTS = 3;
/** Per-hop connect/response ceiling for a remote image fetch. */
const REMOTE_FETCH_TIMEOUT_MS = 10_000;
/** Whole-fetch ceiling, so redirect hops cannot add up to an unbounded wait. */
const REMOTE_FETCH_DEADLINE_MS = 20_000;

/** The image type the magic bytes say, for sources whose declared type is only a hint. */
export function sniffImageMime(bytes: Uint8Array): SafeImageMime | null {
  for (const mime of SAFE_IMAGE_MIMES) {
    if (matchesImageSignature(bytes, mime)) return mime;
  }
  return null;
}

/** Validate raw image bytes against the same rules as an upload, returning the sniffed type. */
export function validateImageBytes(bytes: Uint8Array, maxBytes = DEFAULT_MAX_UPLOAD_BYTES): { bytes: Uint8Array; mime: SafeImageMime } {
  if (bytes.byteLength === 0) throw new MediaValidationError(400, "image is empty");
  if (bytes.byteLength > maxBytes) {
    throw new MediaValidationError(413, `image too large (max ${megabytes(maxBytes)} MB)`);
  }
  const mime = sniffImageMime(bytes);
  if (!mime) {
    throw new MediaValidationError(415, "unsupported image type — expected PNG, JPEG, GIF or WebP (SVG is not accepted)");
  }
  return { bytes, mime };
}

/** Decode a base64 payload, tolerating a `data:` URI prefix and whitespace. */
export function decodeBase64Image(data: string, what: "image" | "file" = "image"): Uint8Array {
  const stripped = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!stripped) throw new MediaValidationError(400, `${what} data is empty`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    throw new MediaValidationError(400, `${what} data is not valid base64`);
  }
  let binary: string;
  try {
    binary = atob(stripped);
  } catch {
    throw new MediaValidationError(400, `${what} data is not valid base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Parse and vet one hop of a remote-image fetch. */
async function vetRemoteUrl(raw: string): Promise<URL> {
  const verdict = await vetOutboundUrl(raw);
  if (!verdict.ok) throw new MediaValidationError(400, verdict.reason);
  return verdict.url;
}

/** Read a response body with a hard byte ceiling, streamed: a remote's content-length may lie. */
async function readCapped(res: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaValidationError(413, `${what} too large (max ${megabytes(maxBytes)} MB)`);
  }
  if (!res.body) throw new MediaValidationError(400, "the URL returned an empty response");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MediaValidationError(413, `${what} too large (max ${megabytes(maxBytes)} MB)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Fetch a remote image and validate it like an upload. */
export async function fetchRemoteImage(
  raw: string,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<{ bytes: Uint8Array; mime: SafeImageMime }> {
  const { bytes } = await fetchRemote(raw, maxBytes, "image");
  return validateImageBytes(bytes, maxBytes);
}

/** Fetch any remote file, named for the last segment of the URL it came from. */
export async function fetchRemoteFile(raw: string, maxBytes = DEFAULT_MAX_UPLOAD_BYTES): Promise<{ bytes: Uint8Array; name: string }> {
  const { bytes, url } = await fetchRemote(raw, maxBytes, "file");
  if (bytes.byteLength === 0) throw new MediaValidationError(400, "the URL returned an empty file");
  let name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // Kept as the URL spells it.
  }
  return { bytes, name: fileName(name) };
}

/** Fetch a remote URL's body, up to `maxBytes`. Redirects are followed by hand so every hop is re-vetted. */
async function fetchRemote(raw: string, maxBytes: number, what: "image" | "file"): Promise<{ bytes: Uint8Array; url: URL }> {
  let url = await vetRemoteUrl(raw);
  // The per-hop timeout bounds one stalled host; the deadline bounds a chain of them.
  const deadline = Date.now() + REMOTE_FETCH_DEADLINE_MS;
  for (let hop = 0; ; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new MediaValidationError(504, `timed out fetching the ${what}`);
    const res = await fetch(url.toString(), {
      redirect: "manual",
      headers: { accept: what === "image" ? "image/*" : "*/*" },
      signal: AbortSignal.timeout(Math.min(REMOTE_FETCH_TIMEOUT_MS, remaining)),
    }).catch((e) => {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new MediaValidationError(504, `timed out fetching the ${what}`);
      }
      throw new MediaValidationError(400, `could not fetch the ${what}: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new MediaValidationError(400, `the URL redirected with no location (${res.status})`);
      if (hop >= MAX_REMOTE_REDIRECTS) throw new MediaValidationError(400, `too many redirects fetching the ${what}`);
      url = await vetRemoteUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new MediaValidationError(400, `the URL returned HTTP ${res.status}`);
    return { bytes: await readCapped(res, maxBytes, what), url };
  }
}

/**
 * The in-document path for a stored image, relative so a document works from any origin; for a
 * file, with the name it is saved under.
 */
export const mediaUrl = (docId: string, hash: string, name?: string): string =>
  `/api/docs/${docId}/media/${hash}${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;

/** The longest name a file keeps. */
const MAX_FILE_NAME_CHARS = 200;

/**
 * A file's name as the media store keeps it, from whatever a browser, an export or a link said:
 * the last segment of a path, one line, no control or direction characters, at most 200
 * characters, and `file` for none.
 */
export function fileName(raw: string): string {
  const base = raw.slice(Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\")) + 1);
  const line = base
    .replace(/\p{Bidi_Control}/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = [...line].slice(0, MAX_FILE_NAME_CHARS).join("").trim();
  return name && name !== "." && name !== ".." ? name : "file";
}

/** The type a file is served with, by its extension; what no entry names is plain bytes. */
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  key: "application/vnd.apple.keynote",
  pages: "application/vnd.apple.pages",
  numbers: "application/vnd.apple.numbers",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  heic: "image/heic",
  svg: "image/svg+xml",
};

export const fileType = (name: string): string => FILE_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/**
 * Store any file under this workspace's prefix, as storeImage stores an image. Only an image of a
 * safe type is ever shown; anything else is served as a download (serveMedia).
 */
export async function storeFile(
  store: BlobStore,
  workspaceId: string,
  bytes: Uint8Array,
  name: string,
  /** A database's own file, kept under its id (mediaKey). */
  databaseId?: string,
): Promise<{ hash: string; size: number; mime: string; name: string }> {
  const kept = fileName(name);
  const sniffed = sniffImageMime(bytes);
  const stored = await storeBlob(store, workspaceId, bytes, sniffed ?? fileType(kept), databaseId);
  return { ...stored, name: kept };
}

/**
 * A workspace id safe to put in a blob key, where `/` or `..` would address
 * another prefix. The tenant is part of the media key and the credential names
 * it; the document id in a media URL is decorative.
 */
export const isKeySafeWorkspaceId = (value: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(value);

/**
 * Blob key for a workspace's copy of an image or file. A database's own files sit under its id,
 * `media/<workspace>/<database>/<hash>`: they stay as long as the database, so a row brought back
 * from its Activity has its files, and go with it. The media sweep, which reclaims only
 * `media/<workspace>/<hash>`, leaves them be.
 */
export function mediaKey(workspaceId: string, hash: string, databaseId?: string): string {
  return databaseId === undefined ? `media/${workspaceId}/${hash}` : `media/${workspaceId}/${databaseId}/${hash}`;
}

/** Delete every file a database holds: its whole prefix. Best-effort; returns how many went. */
export async function deleteDatabaseFiles(store: BlobStore, workspaceId: string, databaseId: string): Promise<number> {
  if (!isKeySafeWorkspaceId(workspaceId) || !isKeySafeWorkspaceId(databaseId)) return 0;
  let deleted = 0;
  try {
    let cursor: string | undefined;
    do {
      const page = await store.list({ prefix: `media/${workspaceId}/${databaseId}/`, ...(cursor ? { cursor } : {}) });
      if (page.objects.length > 0) await store.delete(page.objects.map((o) => o.key));
      deleted += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch {
    // What is left is found again when the workspace goes.
  }
  return deleted;
}

/** Content-hash the bytes and store them under this workspace's prefix if absent. */
export async function storeImage(
  store: BlobStore,
  workspaceId: string,
  bytes: Uint8Array,
  mime: SafeImageMime,
): Promise<{ hash: string; size: number; mime: SafeImageMime }> {
  return storeBlob(store, workspaceId, bytes, mime);
}

async function storeBlob<M extends string>(store: BlobStore, workspaceId: string, bytes: Uint8Array, mime: M, databaseId?: string): Promise<{ hash: string; size: number; mime: M }> {
  if (!isKeySafeWorkspaceId(workspaceId) || (databaseId !== undefined && !isKeySafeWorkspaceId(databaseId))) {
    throw new MediaValidationError(400, "cannot store an image outside a workspace");
  }
  // Narrows away SharedArrayBuffer, which no caller produces.
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = mediaKey(workspaceId, hash, databaseId);
  if (!(await store.head(key))) {
    await store.put(key, bytes, { httpMetadata: { contentType: mime } });
  }
  return { hash, size: bytes.byteLength, mime };
}
