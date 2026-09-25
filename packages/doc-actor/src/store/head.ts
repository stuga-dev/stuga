/**
 * Replacing a document's head wholesale: restoring a version, and rebuilding a
 * head that could not be read. Both are the same operation on different bytes.
 */
import * as Y from "yjs";
import { SNAPSHOT_KEEP, snapshotKey } from "@stuga/protocol/domain/limits";
import { applyMarkdownToYXmlFragment } from "@stuga/crdt-ops";
import type { Peers } from "../session.js";
import { deriveTitle, extractText } from "../text-extract.js";
import type { DocStore, StoreEnv } from "./doc-store.js";
import { pruneUnretained, versionHash } from "./retention.js";

/**
 * Make `next` the head: with `checkpoint`, the live document first recorded as a
 * version of its own; then a fresh seq (monotonic, so the index row is accepted), a
 * new rollback generation committed with it before any socket is reset (the
 * durable epoch fences the tab that was away), the superseded pending log
 * dropped, a version recorded, then every live client sent back for a clean sync.
 * A failed index enqueue is contained: the head is durable and search catches up
 * on the next flush.
 */
async function installHead(
  store: DocStore,
  env: StoreEnv,
  peers: Peers,
  next: Y.Doc,
  authors: string[],
  reason: string,
  detail: Record<string, unknown>,
  checkpoint: boolean,
): Promise<number> {
  return store.exclusive(async () => {
    if (checkpoint) await store.checkpoint();
    const newSeq = store.seq + 1;
    await env.snapshots.put(snapshotKey(store.docId, newSeq), Y.encodeStateAsUpdate(next));
    store.seq = newSeq;
    store.epoch += 1;
    // The head this instance could not read is no longer the head.
    store.hydrationIncomplete = false;
    const plain = extractText(next);
    const evictedVersion = store.ring.note(newSeq, Date.now(), versionHash(store.docId, next, plain));
    console.info("document head installed", { docId: store.docId, seq: newSeq, reason, epoch: store.epoch, ...detail });
    await store.commitHead();
    // The pending log is gone with the head it edited, so nothing is left unsaved.
    store.setPersistDegraded(false);

    try {
      await env.jobs.send({
        kind: "index_doc",
        docId: store.docId,
        snapshotSeq: newSeq,
        title: deriveTitle(plain),
        authors,
        reason,
        recordVersion: true,
        versionFloor: store.ring.floor,
      });
    } catch (err) {
      console.error("head install: index enqueue failed; the head is durable, search catches up on the next flush", {
        docId: store.docId,
        seq: newSeq,
        reason,
        err: String(err),
      });
    }

    for (const ws of peers.all()) peers.resetSocket(ws, `head replaced (${reason})`);
    // After the fan-out, which must not wait on a blob delete.
    await pruneUnretained(env.snapshots, store.docId, store.seq, store.ring, evictedVersion);
    // Also forgets who wrote the replaced document, so no later version names them.
    store.unload();
    return newSeq;
  });
}

/**
 * Roll back to a historical snapshot, after recording what it replaces, so the
 * restore can be undone. Returns the new head seq, or null when the target is gone.
 */
export async function restoreToVersion(store: DocStore, env: StoreEnv, peers: Peers, targetSeq: number): Promise<number | null> {
  await store.ensureLoaded();
  const obj = await env.snapshots.get(snapshotKey(store.docId, targetSeq));
  if (!obj) return null;
  const restored = new Y.Doc();
  Y.applyUpdate(restored, new Uint8Array(await obj.arrayBuffer()), "restore");
  return installHead(store, env, peers, restored, [`restore:v${targetSeq}`], "restore", { fromSeq: targetSeq }, true);
}

/**
 * The newest snapshot below `head` inside the working window, or null. Below the
 * window only milestones survive, and `docs.search_text` (derived from the missing
 * head itself) is fresher than an old milestone.
 */
async function newestRetainedBelow(store: DocStore, env: StoreEnv, head: number): Promise<{ seq: number; bytes: Uint8Array } | null> {
  const floor = Math.max(1, head - SNAPSHOT_KEEP + 1);
  for (let seq = head - 1; seq >= floor; seq--) {
    const obj = await env.snapshots.get(snapshotKey(store.docId, seq));
    if (obj) return { seq, bytes: new Uint8Array(await obj.arrayBuffer()) };
  }
  return null;
}

export type RecoverResult =
  | { status: 409; error: "head readable" }
  | { status: 404; error: "no material" }
  | {
      status: 200;
      seq: number;
      epoch: number;
      from: { kind: "snapshot"; seq: number } | { kind: "search_text"; chars: number };
      stranded: string | null;
    };

/**
 * Rebuild a head this instance could not read. Runs only while
 * `hydrationIncomplete` holds, so it can never replace a readable document.
 * Material, best first: the newest retained snapshot below the missing head, then
 * the node-forwarded `docs.search_text`. Edits accepted against the blank
 * document cannot merge into the rebuild, so they are written beside the
 * snapshots under a `stranded/` key that retention never prunes.
 */
export async function recoverHead(store: DocStore, env: StoreEnv, peers: Peers, fallbackMarkdown: string): Promise<RecoverResult> {
  await store.ensureLoaded();
  if (!store.hydrationIncomplete) return { status: 409, error: "head readable" };
  const missingSeq = store.seq;

  const survivor = await newestRetainedBelow(store, env, missingSeq);
  const next = new Y.Doc();
  let from: { kind: "snapshot"; seq: number } | { kind: "search_text"; chars: number };
  if (survivor) {
    Y.applyUpdate(next, survivor.bytes, "recover");
    from = { kind: "snapshot", seq: survivor.seq };
  } else {
    const fallback = fallbackMarkdown.trim();
    if (fallback === "") {
      console.error("recover: no material to rebuild from; the head is left alone", { docId: store.docId, seq: missingSeq });
      return { status: 404, error: "no material" };
    }
    applyMarkdownToYXmlFragment(next.getXmlFragment("default"), fallback, { origin: "recover" });
    from = { kind: "search_text", chars: fallback.length };
  }

  let stranded: string | null = null;
  if (extractText(store.doc).trim() !== "") {
    stranded = `${store.docId}/stranded/${Date.now()}.bin`;
    await env.snapshots.put(stranded, Y.encodeStateAsUpdate(store.doc));
  }

  // No checkpoint: the live document is not the real one.
  const seq = await installHead(store, env, peers, next, ["system:recovered"], "recover", { missingSeq, from: from.kind }, false);
  console.warn("recover: head rebuilt", { docId: store.docId, missingSeq, seq, from, stranded });
  return { status: 200, seq, epoch: store.epoch, from, stranded };
}
