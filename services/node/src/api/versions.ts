/** A document's version history: list, read, delete, restore, and recover a lost head. */
import { deleteVersion, getDocSearchText, listVersions } from "@stuga/db";
import { snapshotKey } from "@stuga/protocol/domain/limits";
import { recordAudit } from "../audit/record.js";
import { manages } from "../authz/authz.js";
import { authorizedDoc, lockedError, proseOnly } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

// `head_seq` is the newest processed snapshot and delete's floor; edits that recorded no
// version leave it ahead of every listed one. `can_manage` is restore's and delete's gate.
export async function listDocVersions({ ctx, match }: WorkspaceCall): Promise<Response> {
  const doc = await authorizedDoc(ctx, match[1]!);
  if (!doc) return error(404, "not found");
  return json({
    versions: await listVersions(ctx.sql, match[1]!),
    head_seq: doc.snapshot_seq,
    can_manage: proseOnly(doc) !== null && manages(ctx, doc) && !doc.locked,
  });
}

export async function getVersionContent({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const seq = Number(match[2]);
  // Seq 0 is the head counter before the first flush, never a stored snapshot.
  if (!Number.isInteger(seq) || seq < 1) return error(400, "seq must be a positive integer");
  if (!proseOnly(await authorizedDoc(ctx, docId))) return error(404, "not found");
  const u = new URL("http://actor/version-content");
  u.searchParams.set("docId", docId);
  u.searchParams.set("seq", String(seq));
  const res = await ctx.env.docs.get(docId).fetch(u.toString());
  if (!res.ok) return error(res.status === 404 ? 404 : 502, "version content unavailable");
  return json(await res.json());
}

// Delete one historical version. Every snapshot is a complete state, so no
// other depends on it. Not redaction: its text survives as tombstones.
export async function deleteDocVersion({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const seq = Number(match[2]);
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can delete a version");
  const lk = lockedError(doc);
  if (lk) return lk;
  if (!Number.isInteger(seq) || seq < 1) return error(400, "seq must be a positive integer");
  // Never the head, which the actor loads alone. `>=` also covers seqs the actor
  // has flushed but the index job has not yet recorded.
  if (seq >= doc.snapshot_seq) return error(409, "you can't delete the current version");
  // Blob first: a crash leaves a row whose snapshot reads as pruned, where the
  // reverse order would strand an unlisted blob.
  await ctx.env.snapshots.delete(snapshotKey(docId, seq));
  if (!(await deleteVersion(ctx.sql, docId, seq))) return error(404, "not found");
  return json({ deleted: seq });
}

export async function restoreVersion({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can restore a version");
  const lk = lockedError(doc);
  if (lk) return lk;
  const body = (await req.json().catch(() => ({}))) as { seq?: number | string };
  const seq = Number(body.seq);
  if (body.seq === "" || body.seq == null || !Number.isInteger(seq) || seq < 1) {
    return error(400, "seq must be a positive integer");
  }
  const u = new URL("http://actor/restore");
  u.searchParams.set("docId", docId);
  u.searchParams.set("seq", String(seq));
  const res = await ctx.env.docs.get(docId).fetch(u.toString());
  if (!res.ok) return error(res.status === 404 ? 404 : 502, "restore failed");
  return json(await res.json());
}

// Rebuild a document whose head snapshot is gone. Triggered by a person, never a
// sweep: the blob store reports "missing" and "unreadable right now" alike.
// `search_text` is the fallback when no older snapshot survives.
export async function recoverDocument({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = proseOnly(await authorizedDoc(ctx, docId));
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can recover a document");
  const lk = lockedError(doc);
  if (lk) return lk;
  const u = new URL("http://actor/recover");
  u.searchParams.set("docId", docId);
  const res = await ctx.env.docs.get(docId).fetch(u.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fallback_markdown: (await getDocSearchText(ctx.sql, docId)) ?? "" }),
  });
  // 409: the head reads fine. 404: nothing survived to rebuild from.
  if (res.status === 409) {
    return error(409, "this document's snapshot is readable; there is nothing to recover");
  }
  if (res.status === 404) {
    return error(409, "nothing survives to rebuild this document from; restore a specific version instead");
  }
  if (!res.ok) return error(502, "recovery failed");
  recordAudit(ctx, {
    action: "doc.recover",
    targetKind: "doc",
    targetId: docId,
    targetLabel: doc.title,
  });
  return json(await res.json());
}
