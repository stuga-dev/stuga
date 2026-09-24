import { error } from "../http/respond.js";
import type { NodeEnv } from "../env.js";
import { mediaCorp } from "./media-auth.js";
import { isSafeImageMime, mediaKey } from "./media.js";

/** The bytes of one image in `workspaceId`, for a caller already authorized to read that workspace's media. */
export async function serveMedia(
  env: Pick<NodeEnv, "media" | "mediaCookieSameSite">,
  workspaceId: string,
  hash: string,
): Promise<Response> {
  const obj = await env.media.get(mediaKey(workspaceId, hash));
  if (!obj) return error(404, "media not found");
  const contentType = obj.httpMetadata?.contentType;
  // Refuse unvalidated objects (notably SVG) however they got there.
  if (!isSafeImageMime(contentType)) return error(404, "media not found");
  const headers = new Headers();
  headers.set("content-type", contentType);
  // Private: a shared cache would hand an authorized response to the next caller.
  headers.set("cache-control", "private, max-age=31536000, immutable");
  headers.set("cross-origin-resource-policy", mediaCorp(env));
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("x-content-type-options", "nosniff");
  return new Response(obj.body, { headers });
}
