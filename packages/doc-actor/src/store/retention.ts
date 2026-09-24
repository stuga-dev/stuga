/**
 * Snapshot retention and the version ring.
 *
 * A snapshot is kept while any clause holds: inside HEAD's working window
 * (SNAPSHOT_KEEP), on the milestone spine (SNAPSHOT_MILESTONE), or in the ring of
 * the newest VERSION_KEEP recorded versions. These are the clauses the node's SQL
 * applies, the ring by `seq >= docs.version_floor`, so a version the list offers
 * always has its bytes.
 */
import { createHash } from "node:crypto";
import { SNAPSHOT_KEEP, SNAPSHOT_MILESTONE, VERSION_KEEP, snapshotKey } from "@stuga/protocol/domain/limits";
import type { BlobStore } from "@stuga/runtime";

/** Versions run on wall-clock time, so VERSION_KEEP of them cover hours of work, not a burst of flushes. */
export const VERSION_INTERVAL_MS = 5 * 60_000;

/** sha-256 of a document's readable text: text that returned to where it was records no version. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface RingState {
  /** Seqs of the newest VERSION_KEEP recorded versions, ascending. */
  seqs: number[];
  /** Epoch ms of the last recorded version; 0 when none. */
  lastAt: number;
  /** Text hash of the last recorded version; "" when none. */
  lastHash: string;
}

export class VersionRing {
  private state: RingState = { seqs: [], lastAt: 0, lastHash: "" };

  get seqs(): readonly number[] {
    return this.state.seqs;
  }

  /** The oldest member, published as docs.version_floor. */
  get floor(): number {
    return this.state.seqs[0]!;
  }

  /** Whether a flush of `nextSeq` is due for a version: the first snapshot, the last writer leaving, or the interval. */
  due(nextSeq: number, reason: string, now: number): boolean {
    return nextSeq === 1 || reason === "eviction" || now - this.state.lastAt >= VERSION_INTERVAL_MS;
  }

  changedSince(hash: string): boolean {
    return hash !== this.state.lastHash;
  }

  /** Replaced whole on every change, so a held snapshot is a real copy for rollback. */
  snapshot(): RingState {
    return this.state;
  }

  restore(state: RingState): void {
    this.state = state;
  }

  /** Enter `seq`, returning the seq it pushed out (null when the ring had room). */
  note(seq: number, at: number, hash: string): number | null {
    const seqs = [...this.state.seqs, seq];
    let evicted: number | null = null;
    while (seqs.length > VERSION_KEEP) evicted = seqs.shift()!;
    this.state = { seqs, lastAt: at, lastHash: hash };
    return evicted;
  }
}

export function retainedSnapshot(seq: number, head: number, ring: VersionRing): boolean {
  return seq > head - SNAPSHOT_KEEP || seq % SNAPSHOT_MILESTONE === 0 || ring.seqs.includes(seq);
}

/**
 * Delete what stopped being retained as HEAD advanced to `head`. Exactly two
 * seqs can lose retention per advance — the one that fell out of the working
 * window and the one the ring evicted — and whichever event is last for a seq
 * reclaims it, so nothing is listed and nothing is orphaned. Best-effort.
 */
export async function pruneUnretained(
  snapshots: BlobStore,
  docId: string,
  head: number,
  ring: VersionRing,
  evicted: number | null,
): Promise<void> {
  const candidates = new Set<number>();
  const fallen = head - SNAPSHOT_KEEP;
  if (fallen >= 1) candidates.add(fallen);
  if (evicted !== null && evicted >= 1) candidates.add(evicted);
  for (const seq of candidates) {
    if (retainedSnapshot(seq, head, ring)) continue;
    try {
      await snapshots.delete(snapshotKey(docId, seq));
    } catch {
      /* storage stays correct, just larger */
    }
  }
}
