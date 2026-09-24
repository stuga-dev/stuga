/**
 * Reclaiming the media store. `media/<workspace>/<hash>` is deduplicated within
 * a workspace, so the only safe reclaim computes the whole reachable set and
 * moves what is not in it to `trash/`; emptying the trash is a separate, later
 * action. The unit is a (workspace, hash) pair: identical bytes in two
 * workspaces are two objects.
 */
import * as Y from "yjs";
import { yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import {
  type MediaRef,
  type Sql,
  getDocSearchText,
  mediaHashesReferencedInWorkspace,
  mediaRefsInBodies,
  mediaSnapshotCursor,
  mediaSnapshotPage,
} from "@stuga/db";
import { snapshotKey } from "@stuga/protocol/domain/limits";
import type { NodeEnv } from "../env.js";
import { isKeySafeWorkspaceId, mediaKey } from "./media.js";

export type ScanEnv = Pick<NodeEnv, "media" | "snapshots" | "sql">;

const MEDIA_PREFIX = "media/";
/** Mirrors the media layout, so an object moved back lands on the key documents already point at. */
const TRASH_PREFIX = "trash/";

/** Snapshots decoded per page: each is a CRDT decode plus a Markdown serialization in memory. */
const SNAPSHOT_PAGE = 8;
const BODY_PAGE = 500;
const OBJECT_PAGE = 500;

/**
 * Every media hash a text references, matched on the stored path anywhere in
 * it. Over-inclusive on purpose: a false positive keeps an object, a false
 * negative deletes one in use.
 */
export function mediaHashesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\/api\/docs\/[^/\s)]+\/media\/([0-9a-f]{64})/g)) out.add(m[1]!);
  return [...out];
}

/** A pruned snapshot holds no reachable reference; a corrupt one might, so it must stop a reclaim. */
type SnapshotRead = { status: "ok"; markdown: string } | { status: "pruned" } | { status: "corrupt" };

async function readSnapshot(env: ScanEnv, blobKey: string): Promise<SnapshotRead> {
  const obj = await env.snapshots.get(blobKey);
  if (!obj) return { status: "pruned" };
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(await obj.arrayBuffer()));
    return { status: "ok", markdown: yXmlFragmentToMarkdown(doc.getXmlFragment("default")) };
  } catch {
    return { status: "corrupt" };
  } finally {
    doc.destroy();
  }
}

/** `<workspace>/<hash>` under a prefix, or null for any other key shape, which the sweep leaves alone. */
function parseRef(key: string, prefix: string): MediaRef | null {
  const m = /^([A-Za-z0-9_-]{1,64})\/([0-9a-f]{64})$/.exec(key.slice(prefix.length));
  return key.startsWith(prefix) && m ? { workspace: m[1]!, hash: m[2]! } : null;
}

/** A ref safe to build a key from, so no ref can address outside the two prefixes. */
function assertRef(ref: MediaRef): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref.workspace) || !/^[0-9a-f]{64}$/.test(ref.hash)) {
    throw new Error(`not a media object: ${JSON.stringify(ref)}`);
  }
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface StoredObject extends MediaRef {
  size: number;
  uploadedMs: number;
}

export interface TrashedObject extends MediaRef {
  size: number;
  /** When it was moved to the trash: the age the retention window measures. */
  trashedMs: number;
}

export async function listMediaObjects(env: ScanEnv, cursor: string | null, limit = OBJECT_PAGE): Promise<Page<StoredObject>> {
  const listed = await env.media.list({ prefix: MEDIA_PREFIX, limit, ...(cursor ? { cursor } : {}) });
  const items = listed.objects.flatMap((o) => {
    const ref = parseRef(o.key, MEDIA_PREFIX);
    return ref ? [{ ...ref, size: o.size, uploadedMs: o.uploaded.getTime() }] : [];
  });
  return { items, next: listed.truncated ? (listed.cursor ?? null) : null };
}

export async function listTrash(env: ScanEnv, cursor: string | null, limit = OBJECT_PAGE): Promise<Page<TrashedObject>> {
  const listed = await env.media.list({ prefix: TRASH_PREFIX, limit, ...(cursor ? { cursor } : {}) });
  const items = listed.objects.flatMap((o) => {
    const ref = parseRef(o.key, TRASH_PREFIX);
    return ref ? [{ ...ref, size: o.size, trashedMs: o.uploaded.getTime() }] : [];
  });
  return { items, next: listed.truncated ? (listed.cursor ?? null) : null };
}

/** Move objects to the trash exactly as given. The content type moves too, or the object would not serve after a restore. */
export async function trashObjects(env: Pick<ScanEnv, "media">, refs: MediaRef[]): Promise<{ moved: number; missing: MediaRef[] }> {
  refs.forEach(assertRef);
  let moved = 0;
  const missing: MediaRef[] = [];
  for (const ref of refs) {
    const from = mediaKey(ref.workspace, ref.hash);
    const obj = await env.media.get(from);
    if (!obj) {
      missing.push(ref);
      continue;
    }
    await env.media.put(`${TRASH_PREFIX}${ref.workspace}/${ref.hash}`, await obj.arrayBuffer(), { httpMetadata: obj.httpMetadata });
    await env.media.delete(from);
    moved += 1;
  }
  return { moved, missing };
}

/** Destroy trashed objects. The only irreversible step, and it only ever reaches into the trash. */
export async function destroyTrashed(env: Pick<ScanEnv, "media">, refs: MediaRef[]): Promise<number> {
  refs.forEach(assertRef);
  for (const ref of refs) await env.media.delete(`${TRASH_PREFIX}${ref.workspace}/${ref.hash}`);
  return refs.length;
}

/** The references in one page of document bodies, read from `search_text` in SQL. */
export async function referencesInBodies(env: ScanEnv, cursor: string | null, limit = BODY_PAGE): Promise<Page<MediaRef> & { scanned: number }> {
  const page = await mediaRefsInBodies(env.sql, cursor ?? "", limit);
  return { items: page.refs, scanned: page.count, next: page.count === limit ? page.lastDocId : null };
}

/**
 * The references in one page of snapshots SQL cannot answer for: search-hidden
 * bodies, whose `search_text` is stale, and every retained version.
 */
export async function referencesInSnapshots(
  env: ScanEnv,
  cursor: string | null,
  limit = SNAPSHOT_PAGE,
): Promise<Page<MediaRef> & { scanned: number; pruned: number; corrupt: string[] }> {
  const rows = await mediaSnapshotPage(env.sql, cursor ?? "", limit);
  const refs = new Map<string, MediaRef>();
  let pruned = 0;
  const corrupt: string[] = [];
  for (const r of rows) {
    const read = await readSnapshot(env, snapshotKey(r.doc_id, r.seq));
    if (read.status === "pruned") {
      pruned += 1;
      continue;
    }
    if (read.status === "corrupt") {
      corrupt.push(`${r.doc_id}@${r.seq}`);
      continue;
    }
    for (const hash of mediaHashesIn(read.markdown)) refs.set(`${r.workspace_id}/${hash}`, { workspace: r.workspace_id, hash });
  }
  return {
    items: [...refs.values()],
    scanned: rows.length,
    pruned,
    corrupt,
    next: rows.length === limit ? mediaSnapshotCursor(rows[rows.length - 1]!) : null,
  };
}

/** The media hashes a document's indexed body references; read before the row is deleted. Never throws. */
export async function docMediaHashes(sql: Sql, docId: string): Promise<string[]> {
  try {
    const text = await getDocSearchText(sql, docId);
    return text ? mediaHashesIn(text) : [];
  } catch {
    return [];
  }
}

/**
 * Move a just-deleted document's images to the trash unless another body in
 * the same workspace still references them. Moved, not destroyed: a version
 * snapshot SQL cannot see may still point at one. Best-effort; never fails the
 * deletion.
 */
export async function reclaimDeletedDocImages(
  env: Pick<NodeEnv, "media">,
  sql: Sql,
  workspaceId: string,
  hashes: string[],
): Promise<number> {
  if (hashes.length === 0 || !isKeySafeWorkspaceId(workspaceId)) return 0;
  try {
    const stillUsed = await mediaHashesReferencedInWorkspace(sql, workspaceId, hashes);
    const unused = hashes.filter((hash) => !stillUsed.has(hash)).map((hash) => ({ workspace: workspaceId, hash }));
    return (await trashObjects(env, unused)).moved;
  } catch {
    return 0;
  }
}
