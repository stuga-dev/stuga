import type { Fragment } from "postgres";
import { SNAPSHOT_KEEP, SNAPSHOT_MILESTONE } from "@stuga/protocol/domain/limits";
import type { VersionRow } from "./types.js";
import type { Sql } from "./client.js";

/**
 * The versions whose snapshot bytes the document actor keeps, over `versions v`
 * JOIN `docs d`: the working window, the milestone spine, and the version ring.
 * Every query that offers a version must use this, or it offers one whose
 * snapshot is gone (or lets the media sweep reclaim an image a kept one shows).
 */
export function retainedVersion(sql: Sql): Fragment {
  return sql`(
         v.seq > d.snapshot_seq - ${SNAPSHOT_KEEP}
      OR v.seq % ${SNAPSHOT_MILESTONE} = 0
      OR (d.version_floor IS NOT NULL AND v.seq >= d.version_floor)
    )`;
}

export async function listVersions(sql: Sql, docId: string): Promise<VersionRow[]> {
  return sql<VersionRow[]>`
    SELECT v.* FROM versions v
    JOIN docs d ON d.doc_id = v.doc_id
    WHERE v.doc_id = ${docId}
      AND ${retainedVersion(sql)}
    ORDER BY v.seq DESC LIMIT 100`;
}

/**
 * The newest recorded version before `beforeSeq`. Not `beforeSeq - 1`: most
 * flushes record no version, and some snapshots decode as an empty document.
 */
export async function previousVersionSeq(sql: Sql, docId: string, beforeSeq: number): Promise<number | null> {
  const rows = await sql<{ seq: number | null }[]>`
    SELECT max(seq) AS seq FROM versions WHERE doc_id = ${docId} AND seq < ${beforeSeq}`;
  return rows[0]?.seq ?? null;
}

export async function recordVersion(
  sql: Sql,
  v: {
    docId: string;
    seq: number;
    authors: string[];
    blobKey: string;
    /** Oldest seq still in the version ring, stored as docs.version_floor. Omit when there is no ring. */
    versionFloor?: number;
    /** Omit when unknown; a NULL shows nothing where 0 would claim no change. */
    chars?: number;
    charsAdded?: number;
    charsRemoved?: number;
  },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO versions ${tx({
        doc_id: v.docId,
        seq: v.seq,
        authors: v.authors,
        blob_key: v.blobKey,
        chars: v.chars ?? null,
        chars_added: v.charsAdded ?? null,
        chars_removed: v.charsRemoved ?? null,
      })}
      ON CONFLICT (doc_id, seq) DO NOTHING`;
    if (v.versionFloor === undefined) return;
    // GREATEST: a retried or overtaken job carries an older floor, and lowering
    // it would re-offer versions whose snapshots are already reclaimed.
    await tx`
      UPDATE docs SET version_floor = GREATEST(version_floor, ${v.versionFloor})
      WHERE doc_id = ${v.docId}`;
  });
}

/** The row half of deleting a version; the caller removes the snapshot, refuses HEAD and checks tenancy. */
export async function deleteVersion(sql: Sql, docId: string, seq: number): Promise<boolean> {
  const rows = await sql`DELETE FROM versions WHERE doc_id = ${docId} AND seq = ${seq} RETURNING seq`;
  return rows.count > 0;
}
