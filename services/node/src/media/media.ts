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
export function decodeBase64Image(data: string): Uint8Array {
  const stripped = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!stripped) throw new MediaValidationError(400, "image data is empty");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    throw new MediaValidationError(400, "image data is not valid base64");
  }
  let binary: string;
  try {
    binary = atob(stripped);
  } catch {
    throw new MediaValidationError(400, "image data is not valid base64");
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
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaValidationError(413, `image too large (max ${megabytes(maxBytes)} MB)`);
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
      throw new MediaValidationError(413, `image too large (max ${megabytes(maxBytes)} MB)`);
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

/** Fetch a remote image and validate it like an upload. Redirects are followed by hand so every hop is re-vetted. */
export async function fetchRemoteImage(
  raw: string,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<{ bytes: Uint8Array; mime: SafeImageMime }> {
  let url = await vetRemoteUrl(raw);
  // The per-hop timeout bounds one stalled host; the deadline bounds a chain of them.
  const deadline = Date.now() + REMOTE_FETCH_DEADLINE_MS;
  for (let hop = 0; ; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new MediaValidationError(504, "timed out fetching the image");
    const res = await fetch(url.toString(), {
      redirect: "manual",
      headers: { accept: "image/*" },
      signal: AbortSignal.timeout(Math.min(REMOTE_FETCH_TIMEOUT_MS, remaining)),
    }).catch((e) => {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new MediaValidationError(504, "timed out fetching the image");
      }
      throw new MediaValidationError(400, `could not fetch the image: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new MediaValidationError(400, `the URL redirected with no location (${res.status})`);
      if (hop >= MAX_REMOTE_REDIRECTS) throw new MediaValidationError(400, "too many redirects fetching the image");
      url = await vetRemoteUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new MediaValidationError(400, `the URL returned HTTP ${res.status}`);
    return validateImageBytes(await readCapped(res, maxBytes), maxBytes);
  }
}

/** The in-document path for a stored image, relative so a document works from any origin. */
export const mediaUrl = (docId: string, hash: string): string => `/api/docs/${docId}/media/${hash}`;

/**
 * A workspace id safe to put in a blob key, where `/` or `..` would address
 * another prefix. The tenant is part of the media key and the credential names
 * it; the document id in a media URL is decorative.
 */
export const isKeySafeWorkspaceId = (value: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** Blob key for a workspace's copy of an image. */
export function mediaKey(workspaceId: string, hash: string): string {
  return `media/${workspaceId}/${hash}`;
}

/** Content-hash the bytes and store them under this workspace's prefix if absent. */
export async function storeImage(
  store: BlobStore,
  workspaceId: string,
  bytes: Uint8Array,
  mime: SafeImageMime,
): Promise<{ hash: string; size: number; mime: SafeImageMime }> {
  if (!isKeySafeWorkspaceId(workspaceId)) {
    throw new MediaValidationError(400, "cannot store an image outside a workspace");
  }
  // Narrows away SharedArrayBuffer, which no caller produces.
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = mediaKey(workspaceId, hash);
  if (!(await store.head(key))) {
    await store.put(key, bytes, { httpMetadata: { contentType: mime } });
  }
  return { hash, size: bytes.byteLength, mime };
}
