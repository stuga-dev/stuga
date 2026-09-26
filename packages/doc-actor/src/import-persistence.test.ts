import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocActor } from "./doc-actor.js";
import { extractText } from "./text-extract.js";
import { harness, makeActor } from "../test/harness.js";

/**
 * A headless first write (the Markdown import) edits on top of the seeded empty
 * paragraph, so its durable log must carry the seed's structs: replayed on a
 * fresh instance without them, the update would park, the document would decode
 * empty and the flush would skip indexing. A never-edited document still arms nothing.
 * With `flush`, the write is saved as a version before the answer instead.
 */

const MD = "# Import probe\n\nBody paragraph.\n\n- alpha\n- bravo\n";

/** POST /apply-edits with an empty old_string — the Markdown-import seed path. */
const importMarkdown = (doc: DocActor, docId: string, opts: { flush?: boolean } = {}) =>
  doc.fetch(
    new Request(`http://actor/apply-edits?docId=${docId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: "", new_string: MD }], agent: "tester", ...opts }),
    }),
  );

/** Yjs parks updates whose dependencies are absent; this is that buffer. */
function parkedBytes(doc: DocActor): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = (doc as any).store.doc.store as { pendingStructs?: { update?: Uint8Array } | null };
  return store.pendingStructs?.update?.byteLength ?? 0;
}

describe("headless import persistence", () => {
  it("writes a durable journal that replays on its own", async () => {
    const h = harness();
    await importMarkdown(makeActor(h), "doc1");

    // The strongest form of the invariant: the journal alone, applied to a virgin
    // Y.Doc, must reproduce the content with nothing parked.
    const solo = new Y.Doc();
    Y.applyUpdate(solo, h.state.storage.map.get("pending") as Uint8Array);
    const store = solo.store as unknown as { pendingStructs?: { update?: Uint8Array } | null };
    expect(store.pendingStructs?.update?.byteLength ?? 0).toBe(0);
    expect(solo.getXmlFragment("default").toString()).toContain("Body paragraph");
  });

  it("a revived instance decodes the real content, not an empty doc", async () => {
    const h = harness();
    await importMarkdown(makeActor(h), "doc1");

    const revived = makeActor(h); // eviction: fresh instance replays snapshot + journal
    await revived.alarm();

    expect(parkedBytes(revived)).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractText((revived as any).store.doc)).toContain("Body paragraph");
  });

  it("the backstop flush indexes the import (Postgres gets seq + title)", async () => {
    const h = harness();
    await importMarkdown(makeActor(h), "doc1");

    const revived = makeActor(h);
    await revived.alarm();

    expect([...h.snapshots.objects.keys()]).toContain("doc1/1.bin");
    // The pendingOnly branch would snapshot but skip this, leaving snapshot_seq 0.
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]).toMatchObject({
      kind: "index_doc",
      docId: "doc1",
      snapshotSeq: 1,
      title: "Import probe",
    });
  });

  it("still arms nothing for a never-edited doc (no 30s self-wake loop)", async () => {
    const h = harness();
    await makeActor(h).fetch(new Request("http://actor/set-locked?docId=doc9&locked=0"));

    expect(h.state.storage.map.has("pending")).toBe(false);
    expect(h.state.storage.alarm).toBeNull();
  });

  it("with flush, saves the import as a version with its author before answering, leaving nothing for the backstop", async () => {
    const h = harness();
    const res = await importMarkdown(makeActor(h), "doc1", { flush: true });

    expect(await res.json()).toEqual({ applied: true, seq: 1 });
    expect(h.snapshots.keys()).toEqual(["doc1/1.bin"]);
    expect(h.queued).toMatchObject([
      { kind: "index_doc", docId: "doc1", snapshotSeq: 1, title: "Import probe", reason: "headless", recordVersion: true, versionAuthors: ["tester"] },
    ]);
    expect(h.state.storage.map.has("pending")).toBe(false);
    expect(h.state.storage.alarm).toBeNull();
  });

  it("without flush, leaves the save to the backstop", async () => {
    const h = harness();
    const res = await importMarkdown(makeActor(h), "doc1");

    expect(await res.json()).toEqual({ applied: true, seq: 0 });
    expect(h.snapshots.keys()).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.state.storage.map.has("pending")).toBe(true);
    expect(h.state.storage.alarm).not.toBeNull();
  });

  it("with flush, a save that fails still applies, and stays pending for the backstop to retry", async () => {
    const h = harness();
    h.snapshots.put = () => Promise.reject(new Error("No space left on device"));
    const res = await importMarkdown(makeActor(h), "doc1", { flush: true });

    expect(await res.json()).toEqual({ applied: true, seq: 0 });
    expect(h.queued).toEqual([]);
    expect(h.state.storage.map.has("pending")).toBe(true);
    expect(h.state.storage.alarm).not.toBeNull();
  });
});
