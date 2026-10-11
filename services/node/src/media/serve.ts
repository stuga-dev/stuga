import { error } from "../http/respond.js";
import type { NodeEnv } from "../env.js";
import { mediaCorp } from "./media-auth.js";
import { fileName, isKeySafeWorkspaceId, isSafeImageMime, mediaKey } from "./media.js";

/**
 * The bytes of one image or file in `workspaceId`, for a caller already authorized to read that
 * workspace's media: the one `docId`, a database, keeps as its own, else the workspace's. An image
 * of a safe type is shown. Anything else is refused unless `files`, and then only ever downloaded,
 * under `name`, the one its link gives: never rendered, sniffed or run on the node's origin,
 * whatever it holds.
 */
export async function serveMedia(
  env: Pick<NodeEnv, "media" | "mediaCookieSameSite">,
  workspaceId: string,
  hash: string,
  opts: { files?: boolean; name?: string; docId?: string } = {},
): Promise<Response> {
  // A database's own file first, under its id; then the workspace's.
  const own = opts.docId !== undefined && isKeySafeWorkspaceId(opts.docId) ? await env.media.get(mediaKey(workspaceId, hash, opts.docId)) : null;
  const obj = own ?? (await env.media.get(mediaKey(workspaceId, hash)));
  if (!obj) return error(404, "media not found");
  const contentType = obj.httpMetadata?.contentType;
  const image = isSafeImageMime(contentType);
  // Refuse unvalidated objects (notably SVG) as images, however they got there.
  if (!image && !opts.files) return error(404, "media not found");
  const headers = new Headers();
  headers.set("content-type", contentType ?? "application/octet-stream");
  // A HEAD answers with this alone, which is how a document shows a file's size beside its name.
  if (Number.isSafeInteger(obj.size)) headers.set("content-length", String(obj.size));
  if (!image) headers.set("content-disposition", attachment(opts.name));
  // Private: a shared cache would hand an authorized response to the next caller.
  headers.set("cache-control", "private, max-age=31536000, immutable");
  headers.set("cross-origin-resource-policy", mediaCorp(env));
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("x-content-type-options", "nosniff");
  return new Response(obj.body, { headers });
}

/** `attachment`, with the name a file is saved under when its link gives one (RFC 6266, 8187). */
function attachment(name: string | undefined): string {
  if (name === undefined) return "attachment";
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return "attachment";
  }
  const kept = fileName(decoded);
  const ascii = kept.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(kept)}`;
}
