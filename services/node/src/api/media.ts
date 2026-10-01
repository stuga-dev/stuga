/** Images and files: upload into a document, the read ticket a browser carries, and the read itself. */
import { extractToken } from "@stuga/auth";
import { isSessionLive } from "@stuga/db";
import { buildContext } from "../auth/context.js";
import { canWriteDoc } from "../authz/authz.js";
import { authorizedDoc, lockedError } from "../documents/access.js";
import { arrivalOf } from "../http/arrival.js";
import { error, json } from "../http/respond.js";
import type { PublicCall, WorkspaceCall } from "../http/router.js";
import { MediaValidationError, imageUploadLimits, isSafeImageMime, mediaUrl, storeFile, storeImage, validateImageUpload } from "../media/media.js";
import {
  MEDIA_TICKET_TTL_SECONDS,
  clearMediaCookieHeader,
  mediaCookieHeader,
  mintMediaTicket,
  readMediaCookie,
  verifyMediaTicket,
} from "../media/media-auth.js";
import { serveMedia } from "../media/serve.js";
import type { NodeEnv } from "../env.js";

/**
 * A multipart upload of an image or any other file; answers `{ url, hash, size, mime }`, and a
 * file's `name`, its url ending in it. An image of a safe type must be what its type says; any
 * other file is kept as sent, to be downloaded. The listener has already bounded the body.
 */
export async function uploadMedia({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  if (!canWriteDoc(ctx, doc)) return error(403, "view-only access");
  const lk = lockedError(doc);
  if (lk) return lk;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") {
    return error(400, "expected a 'file' field");
  }
  const blob = file as Blob;
  const limit = imageUploadLimits(ctx.env.settings.current().maxBodyBytes);
  // Keyed by the document's workspace, never ctx's, so the bytes land where the document lives; a
  // database keeps what it holds as its own, an image in a cell as much as any other file.
  const database = doc.doc_type === "database";
  if (database || !isSafeImageMime(blob.type.toLowerCase())) {
    if (blob.size === 0) return error(400, "file is empty");
    if (blob.size > limit.bytes) return error(413, `file too large (max ${limit.label})`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const stored = await storeFile(ctx.env.media, doc.workspace_id, bytes, (file as File).name ?? "", database ? docId : undefined);
    return json({ url: mediaUrl(docId, stored.hash, stored.name), ...stored }, { status: 201 });
  }
  let validated;
  try {
    validated = await validateImageUpload(blob, limit.bytes);
  } catch (err) {
    if (err instanceof MediaValidationError) return error(err.status, err.message);
    throw err;
  }
  const { bytes, mime } = validated;
  const stored = await storeImage(ctx.env.media, doc.workspace_id, bytes, mime);
  return json({ url: mediaUrl(docId, stored.hash), ...stored }, { status: 201 });
}

/** The media read ticket, for the workspace the full context resolved (never the header alone). */
export async function mintMediaTicketRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const { alias, workspaceId, arrival } = ctx;
  const ticket = await mintMediaTicket(ctx.env.internalSecret, { alias, workspaceId, sid: ctx.isAgent ? null : ctx.sid, arrival });
  return json(
    { expires_at: ticket.expiresAt, workspace_id: workspaceId },
    {
      headers: {
        "set-cookie": mediaCookieHeader(req, ctx.env, ticket.value, MEDIA_TICKET_TTL_SECONDS),
        "cache-control": "no-store",
      },
    },
  );
}

/** Sign-out. Unauthenticated, or the cookie would be stranded once the token is gone. */
export async function clearMediaTicket({ env, req }: PublicCall): Promise<Response> {
  return json({ ok: true }, { headers: { "set-cookie": clearMediaCookieHeader(req, env) } });
}

/**
 * Media GET: a browser's `<img>` carries the ticket cookie, other clients a
 * bearer token. No WWW-Authenticate on the 401, which would open a basic-auth dialog.
 */
export async function readMedia({ env, req, match }: PublicCall): Promise<Response> {
  const workspaceId = await mediaReadWorkspace(req, env);
  if (!workspaceId) return error(401, "unauthorized");
  const docId = decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");
  return serveMedia(env, workspaceId, match[1]!, { files: true, docId, ...(match[2] === undefined ? {} : { name: match[2] }) });
}

/**
 * The workspace this request may read media from, or null. At the remote address a person's ticket
 * also needs the sign-in it was minted for to be on still; on the node's own network it lapses on
 * its own within MEDIA_TICKET_TTL_SECONDS, with no lookup per image.
 */
async function mediaReadWorkspace(req: Request, env: NodeEnv): Promise<string | null> {
  const arrival = arrivalOf(req);
  const ticket = await verifyMediaTicket(env.internalSecret, readMediaCookie(req), arrival);
  if (ticket) {
    const live =
      arrival === "local" || ticket.sid === null || (await isSessionLive(env.sql, { sessionId: ticket.sid, alias: ticket.alias, arrival }));
    if (live) return ticket.workspaceId;
  }
  if (!extractToken(req)) return null;
  try {
    return (await buildContext(req, env)).workspaceId;
  } catch {
    return null;
  }
}
