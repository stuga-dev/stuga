/** Images: upload into a document, the read ticket a browser carries, and the read itself. */
import { extractToken } from "@stuga/auth";
import { databaseDocMessage } from "../agents/edits.js";
import { buildContext } from "../auth/context.js";
import { canWriteDoc } from "../authz/authz.js";
import { authorizedDoc, lockedError } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { PublicCall, WorkspaceCall } from "../http/router.js";
import { MediaValidationError, imageUploadLimits, mediaUrl, storeImage, validateImageUpload } from "../media/media.js";
import {
  MEDIA_COOKIE,
  MEDIA_TICKET_TTL_SECONDS,
  clearMediaCookieHeader,
  mediaCookieHeader,
  mintMediaTicket,
  readCookie,
  verifyMediaTicket,
} from "../media/media-auth.js";
import { serveMedia } from "../media/serve.js";
import type { NodeEnv } from "../env.js";

/** A multipart image upload; answers `{ url, hash, size, mime }`. The listener has already bounded the body. */
export async function uploadImage({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  // Prose only: nothing references or reclaims an image stored against a database.
  if (doc.doc_type !== "prose") return error(400, databaseDocMessage(docId));
  if (!canWriteDoc(ctx, doc)) return error(403, "view-only access");
  const lk = lockedError(doc);
  if (lk) return lk;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") {
    return error(400, "expected a 'file' field");
  }
  const blob = file as Blob;
  let validated;
  try {
    validated = await validateImageUpload(blob, imageUploadLimits(ctx.env.settings.current().maxBodyBytes).bytes);
  } catch (err) {
    if (err instanceof MediaValidationError) return error(err.status, err.message);
    throw err;
  }
  const { bytes, mime } = validated;
  // Keyed by the document's workspace, never ctx's, so the bytes land where the document lives.
  const stored = await storeImage(ctx.env.media, doc.workspace_id, bytes, mime);
  return json({ url: mediaUrl(docId, stored.hash), ...stored }, { status: 201 });
}

/** The media read ticket, for the workspace the full context resolved (never the header alone). */
export async function mintMediaTicketRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const { alias, workspaceId } = ctx;
  const ticket = await mintMediaTicket(ctx.env.internalSecret, alias, workspaceId);
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
  return serveMedia(env, workspaceId, match[1]!);
}

/** The workspace this request may read media from, or null. */
async function mediaReadWorkspace(req: Request, env: NodeEnv): Promise<string | null> {
  const ticket = await verifyMediaTicket(env.internalSecret, readCookie(req, MEDIA_COOKIE));
  if (ticket) return ticket.workspaceId;
  if (!extractToken(req)) return null;
  try {
    return (await buildContext(req, env)).workspaceId;
  } catch {
    return null;
  }
}
