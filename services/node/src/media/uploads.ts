/**
 * Staged uploads: a caller that holds a file itself, as the stdio server does on the user's machine,
 * stages it here, PUTs the bytes to a signed URL, and stores it by `upload_id`, so the bytes never
 * pass through a model. Two keys per upload in the snapshots store, under one prefix a listing sweeps:
 *   media-uploads/<docId>/<uploadId>.meta   who staged it, and the file's name
 *   media-uploads/<docId>/<uploadId>.body   the bytes
 */
import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEqual } from "@stuga/auth";
import type { DocRow } from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import type { NodeEnv } from "../env.js";
import { error, json } from "../http/respond.js";
import { fileName, imageUploadLimits } from "./media.js";

const PREFIX = "media-uploads/";
/** How long a staged upload takes its bytes and waits to be stored. */
export const MEDIA_UPLOAD_TTL_MS = 60 * 60_000;

interface UploadMeta {
  created_by: string;
  name: string;
}

export interface MediaUploadTicket {
  upload_id: string;
  /** PUT the whole file here; the signed URL is the credential and works once. */
  upload_url: string;
  /** The same target as a path, for a client that reaches the node at another origin. */
  upload_path: string;
  max_bytes: number;
  expires_at: string;
}

/** `upl_<expiry base36>_<random>`: the expiry rides in the id, so a listing finds stale ones unopened. */
function newUploadId(now: number): string {
  return `upl_${(now + MEDIA_UPLOAD_TTL_MS).toString(36)}_${randomBytes(9).toString("hex")}`;
}

/** When an upload id says it expires, or null for no id of ours. */
export function uploadExpiry(uploadId: string): number | null {
  const m = /^upl_([0-9a-z]+)_[0-9a-f]{18}$/.exec(uploadId);
  return m ? parseInt(m[1]!, 36) : null;
}

const keyOf = (docId: string, uploadId: string, part: "meta" | "body"): string => `${PREFIX}${docId}/${uploadId}.${part}`;

/** The upload URL's credential: domain-separated, scoped to one document and one upload, expiring with the id. */
function sign(secret: string, docId: string, uploadId: string): string {
  return createHmac("sha256", secret).update(`media-upload:${docId}:${uploadId}`).digest("hex");
}

/** The largest file the node stores: its upload limit. */
const maxBytes = (env: Pick<NodeEnv, "settings">): number => imageUploadLimits(env.settings.current().maxBodyBytes).bytes;

/** Stage an upload of a file named `name` into `doc`, which the caller may write, and hand back where to PUT it. */
export async function createMediaUpload(ctx: Ctx, doc: DocRow, name: string): Promise<MediaUploadTicket> {
  const uploadId = newUploadId(Date.now());
  const meta: UploadMeta = { created_by: ctx.alias, name: fileName(name) };
  await ctx.env.snapshots.put(keyOf(doc.doc_id, uploadId, "meta"), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
  const path = `/api/docs/${encodeURIComponent(doc.doc_id)}/media/uploads/${uploadId}?sig=${sign(ctx.env.internalSecret, doc.doc_id, uploadId)}`;
  return {
    upload_id: uploadId,
    upload_url: `${ctx.servedOrigin}${path}`,
    upload_path: path,
    max_bytes: maxBytes(ctx.env),
    expires_at: new Date(uploadExpiry(uploadId)!).toISOString(),
  };
}

/** `PUT /api/docs/:id/media/uploads/:uploadId?sig=…`, answered without a bearer: the signature grants one write of one file. */
export async function handleMediaUpload(env: NodeEnv, req: Request, docId: string, uploadId: string, sig: string | null): Promise<Response> {
  if (!sig || !/^[0-9a-f]{64}$/.test(sig) || !constantTimeEqual(sign(env.internalSecret, docId, uploadId), sig)) {
    return error(403, "invalid upload signature");
  }
  const expiry = uploadExpiry(uploadId);
  if (expiry === null || expiry < Date.now()) return error(410, "this upload has expired — start a new one");
  if (!(await env.snapshots.head(keyOf(docId, uploadId, "meta")).catch(() => null))) return error(404, "no such upload");
  const body = keyOf(docId, uploadId, "body");
  if (await env.snapshots.head(body).catch(() => null)) return error(409, "this upload already has a file — start a new one to send another");
  const bytes = new Uint8Array(await req.arrayBuffer());
  const max = maxBytes(env);
  if (bytes.byteLength === 0) return error(400, "the uploaded file is empty");
  if (bytes.byteLength > max) return error(413, `file too large (max ${Math.floor(max / (1024 * 1024))} MB)`);
  await env.snapshots.put(body, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  return json({ upload_id: uploadId, bytes: bytes.byteLength }, { status: 201 });
}

/** The file `uploadId` staged for `doc`, taken: its staging is gone once read. */
export async function takeMediaUpload(ctx: Ctx, doc: DocRow, uploadId: string): Promise<{ bytes: Uint8Array; name: string } | { error: string }> {
  const expiry = uploadExpiry(uploadId);
  if (expiry === null || expiry < Date.now()) return { error: "no such upload, or it has expired — start a new one" };
  const metaObj = await ctx.env.snapshots.get(keyOf(doc.doc_id, uploadId, "meta")).catch(() => null);
  let meta: UploadMeta | null = null;
  try {
    meta = metaObj ? (JSON.parse(await metaObj.text()) as UploadMeta) : null;
  } catch {
    // Unreadable is as good as gone.
  }
  if (!meta) return { error: "no such upload, or it has expired — start a new one" };
  if (meta.created_by !== ctx.alias) return { error: "this upload was started by another credential" };
  const body = await ctx.env.snapshots.get(keyOf(doc.doc_id, uploadId, "body")).catch(() => null);
  if (!body) return { error: "nothing was uploaded yet: PUT the file to upload_url first" };
  const bytes = new Uint8Array(await body.arrayBuffer());
  await ctx.env.snapshots.delete([keyOf(doc.doc_id, uploadId, "meta"), keyOf(doc.doc_id, uploadId, "body")]);
  return { bytes, name: meta.name };
}

/** Delete every expired staged upload on the node. Returns how many keys went. */
export async function sweepExpiredMediaUploads(env: Pick<NodeEnv, "snapshots">, now: number): Promise<number> {
  let swept = 0;
  let cursor: string | undefined;
  do {
    const page = await env.snapshots.list({ prefix: PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    const stale = page.objects
      .map((o) => o.key)
      .filter((key) => {
        const exp = uploadExpiry((key.split("/")[2] ?? "").replace(/\.(meta|body)$/, ""));
        return exp !== null && exp < now;
      });
    if (stale.length > 0) await env.snapshots.delete(stale);
    swept += stale.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return swept;
}
