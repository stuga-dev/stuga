/**
 * The document's durable state: the live Y.Doc, the pending update log, the
 * head seq, the rollback epoch, the lock flag and the version ring, plus the
 * flush that turns pending edits into a snapshot and an index job, and the
 * promotion that records a head a flush left without its version.
 *
 * Durability: accepted updates merge into `pending`, which is mirrored to actor
 * storage every PERSIST_THRESHOLD updates; a flush snapshots the whole document
 * to the blob store. The flush alarm, the close/error flush and the peers' own
 * sync handshake are the backstops for the unmirrored tail.
 */
import * as Y from "yjs";
import { DOC_FLUSH_INTERVAL_MS, snapshotKey } from "@stuga/protocol/domain/limits";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { encodeBinary, encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode, type PersistDegradedPayload } from "@stuga/protocol/wire/opcodes";
import { applyMarkdownToYXmlFragment, yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import type { ActorStorage, BlobStore, JobQueue } from "@stuga/runtime";
import type { Peers } from "../session.js";
import { deriveTitle, extractText } from "../text-extract.js";
import { pruneUnretained, versionHash, VersionRing, type RingState } from "./retention.js";

/** The version authors a recording took; `giveBack` returns them when no version was recorded. */
interface TakenAuthors {
  authors: string[];
  giveBack: () => void;
}

/** A document's plain text and version hash, read together. */
interface Hashed {
  plain: string;
  hash: string;
}

/**
 * The version of what a document keeps in its actor storage: the keys below and the run ledger's.
 * The host stamps each store with it and refuses one stamped higher. A change to a stored shape
 * raises it, together with the step in the host that brings an older store forward.
 */
export const DOC_STORE_VERSION = 1;

const FLUSH_THRESHOLD = 100; // updates
const PERSIST_THRESHOLD = 10; // updates

/**
 * A pending log above this snapshots straight to the blob store instead of being
 * journaled as one storage value; it is what lets a whole large document arrive
 * in one headless write.
 */
export const PENDING_SNAPSHOT_BYTES = 1024 * 1024;

/** What the actor persists under "meta". */
interface StoredMeta {
  docId: string;
  seq: number;
  epoch: number;
  ring: RingState;
}

export interface StoreEnv {
  snapshots: BlobStore;
  jobs: JobQueue<IndexMessage>;
}

/** Origins that replay existing state and must not be journaled as edits. */
const REPLAY_ORIGINS = new Set(["hydrate", "preview", "restore"]);

export class DocStore {
  doc = new Y.Doc();
  docId = "";
  /** Head counter: flush writes `seq + 1`, so `<id>/0.bin` never exists. */
  seq = 0;
  /** Rollback generation, bumped by every head install; 0 = never restored. */
  epoch = 0;
  /** Mirrors docs.locked (pushed by /set-locked). Freezes content, not persistence. */
  locked = false;
  readonly ring = new VersionRing();
  /**
   * Set when meta names a snapshot the store did not return: the in-memory doc is
   * not the real document, so flushing would overwrite the head with a partial
   * one. Cleared only by installing a head.
   */
  hydrationIncomplete = false;
  /** Whether the last flush failed. Reporting only; the alarm owns the retry. */
  persistDegraded = false;

  private loaded = false;
  private dirty = false;
  /** Updates applied since the last snapshot, cumulatively merged. */
  private pending: Uint8Array | null = null;
  private updatesSinceFlush = 0;
  private updatesSincePersist = 0;
  private flushing = false;
  /** The in-flight flush or promotion; a head install waits for it, so the two never write the head or the ring at once. */
  private flushInFlight: Promise<void> | null = null;
  private replacingHead = false;
  /** Who edited since the last flush. */
  private contributors = new Set<string>();
  /**
   * Who edited since the last recorded version, for its authors. In memory only: a restart
   * between a flush and the version loses it.
   */
  private versionAuthors = new Set<string>();
  /**
   * Whether the clean head at `seq` is owed a version against the one hashed `lastHash`,
   * so a saved head is serialized once at most. In memory only.
   */
  private owedMemo: { seq: number; lastHash: string; owed: Hashed | null } | null = null;
  /** Set by the update handler, so applyFromClient can tell a partial apply from a pure gap. */
  private sawUpdateEvent = false;
  /** Latched by `destroy`; nothing may write to storage afterwards. */
  private destroyed = false;

  constructor(
    private readonly storage: ActorStorage,
    private readonly env: StoreEnv,
    private readonly peers: Peers,
  ) {
    this.bindDoc();
  }

  private bindDoc(): void {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => this.onDocUpdate(update, origin));
  }

  /** The live document as Markdown. */
  markdown(): string {
    return yXmlFragmentToMarkdown(this.doc.getXmlFragment("default"));
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded || this.destroyed) return;
    const stored = await this.storage.get<StoredMeta>("meta");
    if (stored) {
      this.docId = stored.docId;
      this.seq = stored.seq;
      this.epoch = stored.epoch;
      this.ring.restore(stored.ring);
    }
    this.locked = (await this.storage.get<boolean>("locked")) ?? false;
    if (this.docId && this.seq > 0) {
      const obj = await this.env.snapshots.get(snapshotKey(this.docId, this.seq));
      if (obj) {
        Y.applyUpdate(this.doc, new Uint8Array(await obj.arrayBuffer()), "hydrate");
      } else {
        // An acknowledged snapshot is gone: flushing emptiness over it would make a
        // recoverable gap permanent, so refuse and name the repair.
        this.hydrationIncomplete = true;
        console.error("snapshot missing for a doc that has one; refusing to flush over it", {
          docId: this.docId,
          seq: this.seq,
          key: snapshotKey(this.docId, this.seq),
          recover: `POST /api/docs/${this.docId}/recover`,
        });
      }
    }
    // Before the log replays over the head, which may be the version the hash describes.
    if (this.ring.legacyHash) await this.upgradeLegacyHash();
    // The durable log holds edits the last instance acked but never snapshotted.
    const pending = await this.storage.get<Uint8Array>("pending");
    if (pending && pending.byteLength > 0) {
      Y.applyUpdate(this.doc, pending, "hydrate");
      this.pending = pending;
      this.dirty = true;
      this.updatesSincePersist = 0;
      // Whatever woke us, a dirty document needs its backstop (a fired alarm is consumed before it runs).
      await this.armAlarms();
    }
    // A never-edited document gets one empty paragraph so it opens ready to type.
    // Tagged "hydrate" so it does not dirty every cold load.
    const root = this.doc.getXmlFragment("default");
    if (root.length === 0) {
      const beforeSeed = Y.encodeStateVector(this.doc);
      this.doc.transact(() => {
        root.insert(0, [new Y.XmlElement("paragraph")]);
      }, "hydrate");
      // A headless first write edits on top of the seed, so the log must carry the
      // seed's structs or it would replay as a dependency gap and never index.
      if (!this.pending) this.pending = Y.encodeStateAsUpdate(this.doc, beforeSeed);
    }
    this.loaded = true;
  }

  /**
   * Replace the plain-text hash v0.1.x stored with the version hash of the version it
   * describes, read from that version's snapshot (the ring keeps it), and save it, so
   * formatting counts from the first load. Left to compare plain text when the snapshot
   * cannot be read.
   */
  private async upgradeLegacyHash(): Promise<void> {
    const newest = this.ring.newest;
    if (newest === 0) return;
    let version = this.doc;
    if (newest !== this.seq || this.hydrationIncomplete) {
      try {
        const obj = await this.env.snapshots.get(snapshotKey(this.docId, newest));
        if (!obj) return;
        version = new Y.Doc();
        Y.applyUpdate(version, new Uint8Array(await obj.arrayBuffer()));
      } catch (err) {
        console.warn("version hash: kept the v0.1.x one; the version's snapshot could not be read", { docId: this.docId, seq: newest, err: String(err) });
        return;
      }
    }
    this.ring.rehash(versionHash(this.docId, version, extractText(version)));
    if (this.destroyed) return;
    try {
      await this.storeMeta();
    } catch (err) {
      console.warn("version hash: not saved; the next save keeps it", { docId: this.docId, err: String(err) });
    }
  }

  private onDocUpdate(update: Uint8Array, origin: unknown): void {
    if (typeof origin === "string" && REPLAY_ORIGINS.has(origin)) return;
    this.sawUpdateEvent = true;
    this.journal(update, origin);
    const big = (this.pending?.byteLength ?? 0) > PENDING_SNAPSHOT_BYTES;
    if (this.updatesSinceFlush >= FLUSH_THRESHOLD || big) {
      // A large paste can trip this before the debounced persist would; persist it first.
      if (big) void this.forcePersistPending().catch(() => {});
      void this.flush("threshold").catch(() => {});
    }
  }

  private journal(update: Uint8Array, origin: unknown): void {
    this.pending = this.pending ? Y.mergeUpdates([this.pending, update]) : update;
    this.dirty = true;
    this.updatesSinceFlush++;
    this.updatesSincePersist++;
    if (origin && typeof origin === "object") {
      const o = origin as { alias?: string; agent?: string };
      const author = o.agent || o.alias;
      if (author) {
        this.contributors.add(author);
        this.versionAuthors.add(author);
      }
    }
  }

  /**
   * Apply a client update, journaling it even when Yjs integrates nothing. An
   * update whose dependency is missing is parked in `pendingStructs` and fires no
   * update event, yet it has been acked and broadcast. Keyed on parked bytes,
   * because one update can both integrate content and strand more.
   */
  applyFromClient(update: Uint8Array, origin: { alias: string; agent: string | null }): void {
    const parkedBefore = this.parkedBytes();
    this.sawUpdateEvent = false;
    Y.applyUpdate(this.doc, update, origin);
    const parkedAfter = this.parkedBytes();
    if (parkedAfter <= parkedBefore) return;
    const partiallyApplied = this.sawUpdateEvent;
    this.journal(update, origin);
    console.warn("crdt update parked behind a missing dependency; journaled", {
      docId: this.docId,
      alias: origin.alias,
      bytes: update.byteLength,
      parkedBytes: parkedAfter,
      partiallyApplied,
    });
  }

  /** Bytes parked in Yjs's (untyped) pending-structs buffer, which grows and drains. */
  private parkedBytes(): number {
    const store = this.doc.store as unknown as { pendingStructs?: { update?: Uint8Array } | null };
    return store.pendingStructs?.update?.byteLength ?? 0;
  }

  /** Everything held is parked behind a missing dependency, so the document decodes empty. */
  private parkedOnly(plain: string): boolean {
    return plain.trim() === "" && this.parkedBytes() > 0;
  }

  /** Mirror the pending log at most once per PERSIST_THRESHOLD updates; arm the backstop on a batch's first edit. */
  async maybePersistPending(): Promise<void> {
    if (this.updatesSincePersist >= PERSIST_THRESHOLD) await this.forcePersistPending();
    else if (this.updatesSincePersist === 1) await this.armAlarms();
  }

  async forcePersistPending(): Promise<void> {
    if (this.destroyed) return;
    if (this.pending) await this.storage.put("pending", this.pending);
    // Meta travels with the log, so an alarm on a cold instance knows its document.
    if (this.docId && !this.destroyed) await this.storeMeta();
    this.updatesSincePersist = 0;
    await this.armAlarms();
  }

  /** Every "meta" write goes through here, so the epoch and the ring are never dropped by a partial write. */
  private storeMeta(): Promise<void> {
    return this.storage.put("meta", {
      docId: this.docId,
      seq: this.seq,
      epoch: this.epoch,
      ring: this.ring.snapshot(),
    } satisfies StoredMeta);
  }

  /**
   * Arm the flush backstop while dirty; once clean, the version the head may be owed,
   * when the interval allows it. An earlier alarm is left alone. Without a docId
   * flush cannot run, so an alarm would re-arm forever: clear it instead.
   */
  async armAlarms(): Promise<void> {
    if (this.destroyed) return;
    let due: number;
    if (this.dirty) {
      if (!this.docId) {
        await this.storage.deleteAlarm();
        return;
      }
      due = Date.now() + DOC_FLUSH_INTERVAL_MS;
    } else if (this.pastNewestVersion() && this.recalledOwed() !== null) {
      // Owed, or not known yet: the alarm's promotion serializes the head, once. The interval is
      // already past when a promotion failed or was held off, or when the store kept no alarm
      // for it (an older build, a restart that lost it): fire at the flush cadence.
      const now = Date.now();
      due = this.ring.nextAt > now ? this.ring.nextAt : now + DOC_FLUSH_INTERVAL_MS;
    } else {
      return;
    }
    const current = await this.storage.getAlarm();
    if (current === null || current > due) await this.storage.setAlarm(due);
  }

  /** Whether the clean, readable head is past the newest version, so it may be owed one. */
  private pastNewestVersion(): boolean {
    return this.loaded && !this.dirty && !!this.docId && !this.hydrationIncomplete && this.seq > this.ring.newest;
  }

  /** The verdict already reached for this head and ring, or undefined. */
  private recalledOwed(): Hashed | null | undefined {
    const memo = this.owedMemo;
    return memo && memo.seq === this.seq && memo.lastHash === this.ring.lastHash ? memo.owed : undefined;
  }

  /**
   * The clean head's text and version hash when it is owed a version it can take,
   * else null, serialized once per head. Read from the head and the ring alone, so a
   * cold instance agrees once loaded.
   */
  private owedVersion(): Hashed | null {
    if (!this.pastNewestVersion()) return null;
    const recalled = this.recalledOwed();
    if (recalled !== undefined) return recalled;
    const owed = this.changedHead();
    this.owedMemo = { seq: this.seq, lastHash: this.ring.lastHash, owed };
    return owed;
  }

  /** The live document's text and version hash when it differs from the newest version and can be one, else null. */
  private changedHead(): Hashed | null {
    const plain = extractText(this.doc);
    if (this.parkedOnly(plain)) return null;
    const hash = versionHash(this.docId, this.doc, plain);
    return this.ring.changedSince(hash, plain) ? { plain, hash } : null;
  }

  /** Hand the version authors to a version being recorded; edits from now on count toward the next one. */
  private takeVersionAuthors(): TakenAuthors {
    const held = this.versionAuthors;
    this.versionAuthors = new Set();
    return {
      authors: [...held],
      giveBack: () => {
        this.versionAuthors = new Set([...held, ...this.versionAuthors]);
      },
    };
  }

  /**
   * Apply `next` to the live fragment as a 3-way merge against `current`, which
   * the caller read with no await since, broadcast the delta, and journal it.
   */
  async commitMarkdown(next: string, current: string, origin: unknown, largeReason: string): Promise<void> {
    if (next === current) return;
    const before = Y.encodeStateVector(this.doc);
    applyMarkdownToYXmlFragment(this.doc.getXmlFragment("default"), next, { origin, originalMarkdown: current });
    const update = Y.encodeStateAsUpdate(this.doc, before);
    if (update.byteLength > 0) this.peers.broadcast(encodeBinary(Opcode.UPDATE, update));
    if ((this.pending?.byteLength ?? 0) > PENDING_SNAPSHOT_BYTES) await this.flush(largeReason);
    else await this.forcePersistPending();
  }

  async flush(reason: string): Promise<void> {
    await this.ensureLoaded();
    if (this.flushing || this.replacingHead || this.destroyed) return;
    if (!this.dirty || !this.docId || this.hydrationIncomplete) return;
    await this.inFlight(async () => {
      try {
        if (await this.writeSnapshot(reason, null)) this.setPersistDegraded(false);
      } catch (err) {
        console.error("flush failed; reverted in-memory state, will retry on alarm", { docId: this.docId, reason, err: String(err) });
        // Reported on the first failure: the person typing is the one who can act, by keeping the tab open.
        this.setPersistDegraded(true);
        await this.armAlarms();
      }
    });
  }

  /**
   * Record the clean head as a version without writing a snapshot: the seq a flush
   * inside the interval left without one. Same guards as flush, and the same slot.
   */
  async promote(reason: string): Promise<void> {
    await this.ensureLoaded();
    if (this.flushing || this.replacingHead || this.destroyed) return;
    if (!this.ring.due(this.seq, reason, Date.now())) return;
    const owed = this.owedVersion();
    if (!owed) return;
    await this.inFlight(async () => {
      const prevRing = this.ring.snapshot();
      const taken = this.takeVersionAuthors();
      const evictedVersion = this.ring.note(this.seq, Date.now(), owed.hash);
      let ringStored = false;
      try {
        // The seq is durable already, so the ring goes first: a version the node lists must
        // have its bytes kept. The consumer finds the seq already indexed.
        await this.storeMeta();
        ringStored = true;
        if (this.destroyed) return;
        await this.env.jobs.send({
          kind: "index_doc",
          docId: this.docId,
          snapshotSeq: this.seq,
          title: deriveTitle(owed.plain),
          authors: [...this.contributors],
          reason,
          recordVersion: true,
          versionFloor: this.ring.floor,
          versionAuthors: taken.authors,
        });
      } catch (err) {
        this.ring.restore(prevRing);
        taken.giveBack();
        console.error("version failed; reverted the ring, will retry on alarm", { docId: this.docId, seq: this.seq, reason, err: String(err) });
        // Best effort: a stored ring the node never heard of costs the seq's bytes, not a listed version.
        if (ringStored) await this.storeMeta().catch(() => {});
        await this.armAlarms();
        return;
      }
      console.info("head recorded as a version", { docId: this.docId, seq: this.seq, reason });
      await pruneUnretained(this.env.snapshots, this.docId, this.seq, this.ring, evictedVersion);
    });
  }

  /**
   * Inside `exclusive`, before a head install: record the live document, unsaved
   * edits included, as a version of its own, so what the install replaces can be
   * restored. Nothing is written when its Markdown is the newest version's. Throws
   * on failure, so the install does not go ahead.
   */
  async checkpoint(): Promise<void> {
    await this.ensureLoaded();
    if (this.destroyed || !this.docId || this.hydrationIncomplete) return;
    // A clean head is the snapshot at `seq`, so its verdict is the one kept for the owed version.
    const changed = this.dirty ? this.changedHead() : this.owedVersion();
    if (!changed) return;
    if (await this.writeSnapshot("checkpoint", changed.hash)) this.setPersistDegraded(false);
  }

  /** Run `fn` in the flush slot: flushes and promotions never overlap, and a head install waits for it. */
  private async inFlight(fn: () => Promise<void>): Promise<void> {
    this.flushing = true;
    let releaseFlight!: () => void;
    this.flushInFlight = new Promise<void>((res) => {
      releaseFlight = res;
    });
    try {
      await fn();
    } finally {
      this.flushing = false;
      releaseFlight();
      this.flushInFlight = null;
    }
  }

  /**
   * Snapshot the live document as `seq + 1` and send its index job, recording a
   * version when due, or `forcedHash`'s whatever the interval says. A failure rolls
   * memory back, so the actor stays dirty and the alarm retries, and rethrows. False
   * when a destroy cut it short.
   */
  private async writeSnapshot(reason: string, forcedHash: string | null): Promise<boolean> {
    const prev = {
      seq: this.seq,
      dirty: this.dirty,
      pending: this.pending,
      sinceFlush: this.updatesSinceFlush,
      sincePersist: this.updatesSincePersist,
      ring: this.ring.snapshot(),
    };
    // Edits arriving during the awaits merge into a fresh `pending` and survive this flush.
    const flushedPending = this.pending;
    const nextSeq = this.seq + 1;
    // Read together, so the title and the version hash describe the snapshot's bytes
    // and an edit arriving during the awaits counts toward the next version. The
    // Markdown is serialized only when a version is due.
    const snapshot = Y.encodeStateAsUpdate(this.doc);
    const plain = extractText(this.doc);
    const now = Date.now();
    const hash = forcedHash ?? (this.ring.due(nextSeq, reason, now) ? versionHash(this.docId, this.doc, plain) : null);
    const taken = this.takeVersionAuthors();
    let recordedVersion = false;
    let evictedVersion: number | null = null;
    let leftClean = false;
    try {
      await this.env.snapshots.put(snapshotKey(this.docId, nextSeq), snapshot);
      if (this.destroyed) return false;

      const authors = [...this.contributors];
      if (this.parkedOnly(plain)) {
        // Snapshot it, but indexing would blank its search text.
        console.warn("snapshot flushed with dependency-pending bytes only; skipping index", {
          docId: this.docId,
          seq: nextSeq,
          reason,
          bytes: snapshot.byteLength,
        });
      } else {
        recordedVersion = hash !== null && this.ring.changedSince(hash, plain);
        if (recordedVersion) evictedVersion = this.ring.note(nextSeq, now, hash!);
        // Enqueue before committing clean state: if the send fails, durable state
        // is untouched and the flush reruns; a duplicate job is absorbed downstream.
        // The body is not sent; the consumer re-reads the snapshot.
        await this.env.jobs.send({
          kind: "index_doc",
          docId: this.docId,
          snapshotSeq: nextSeq,
          title: deriveTitle(plain),
          authors,
          reason,
          // Only the actor knows which seqs are history, so it publishes the ring floor.
          ...(recordedVersion
            ? { recordVersion: true as const, versionFloor: this.ring.floor, versionAuthors: taken.authors }
            : { recordVersion: false as const }),
        });
        this.contributors.clear();
      }
      if (!recordedVersion) taken.giveBack();
      if (this.destroyed) return false;

      this.seq = nextSeq;
      this.updatesSinceFlush = 0;
      this.updatesSincePersist = 0;
      leftClean = this.pending === flushedPending;
      if (leftClean) {
        this.pending = null;
        this.dirty = false;
        await Promise.all([this.storeMeta(), this.storage.delete("pending"), this.storage.deleteAlarm()]);
      } else {
        // Rebase the durable log onto the edits that arrived meanwhile.
        await Promise.all([this.storeMeta(), this.pending ? this.storage.put("pending", this.pending) : Promise.resolve()]);
      }
    } catch (err) {
      this.seq = prev.seq;
      this.dirty = prev.dirty;
      this.pending = prev.pending;
      this.updatesSinceFlush = prev.sinceFlush;
      this.updatesSincePersist = prev.sincePersist;
      this.ring.restore(prev.ring);
      taken.giveBack();
      throw err;
    }

    // The head is durable: nothing from here on may roll memory back behind it.
    // A head that hashed the same as the newest version is owed nothing.
    if (leftClean && hash !== null && !recordedVersion) this.owedMemo = { seq: nextSeq, lastHash: this.ring.lastHash, owed: null };
    // The backstop for edits that arrived meanwhile; for a head left without its version, the interval.
    if (!leftClean || !recordedVersion) {
      await this.armAlarms().catch((err: unknown) => {
        console.error("flush: alarm not armed; the next edit or open arms it", { docId: this.docId, seq: nextSeq, err: String(err) });
      });
    }
    console.info("snapshot flushed", { docId: this.docId, seq: nextSeq, reason, bytes: snapshot.byteLength, version: recordedVersion });
    // After the new head is durable, so a crash mid-prune costs disk, never data.
    await pruneUnretained(this.env.snapshots, this.docId, this.seq, this.ring, evictedVersion);
    return true;
  }

  /** Edge-triggered: a flush failing on every backstop must not re-broadcast. New sockets learn the level at handshake. */
  setPersistDegraded(degraded: boolean): void {
    if (this.persistDegraded === degraded) return;
    this.persistDegraded = degraded;
    this.peers.broadcast(encodeJson(Opcode.PERSIST_DEGRADED, { degraded } satisfies PersistDegradedPayload));
  }

  /**
   * Run `fn` with flushes and promotions held off and any in-flight one drained
   * first, so a head install and a flush never claim the same seq.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.replacingHead = true;
    try {
      if (this.flushInFlight) await this.flushInFlight;
      return await fn();
    } finally {
      this.replacingHead = false;
    }
  }

  /** Persist a newly installed head and drop the superseded log, which would otherwise replay over it. */
  async commitHead(): Promise<void> {
    await this.storeMeta();
    await this.storage.delete("pending");
  }

  /** Forget the in-memory document, and who wrote it, so the next request re-hydrates from storage. */
  unload(): void {
    this.doc = new Y.Doc();
    this.bindDoc();
    this.loaded = false;
    this.dirty = false;
    this.pending = null;
    this.updatesSinceFlush = 0;
    this.updatesSincePersist = 0;
    this.contributors.clear();
    this.versionAuthors.clear();
    this.owedMemo = null;
  }

  /** Whether anything is waiting to be flushed. */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** Wipe durable state and latch, so no later flush or persist can write the document back. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.flushInFlight) await this.flushInFlight;
    await this.storage.deleteAll();
    this.unload();
    this.seq = 0;
    this.epoch = 0;
    this.locked = false;
    this.ring.restore({ seqs: [], lastAt: 0, lastHash: "" });
    this.hydrationIncomplete = false;
    this.persistDegraded = false;
  }

  async setLocked(locked: boolean): Promise<void> {
    this.locked = locked;
    await this.storage.put("locked", locked);
  }
}
