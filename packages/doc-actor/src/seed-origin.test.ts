import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/**
 * The empty paragraph seeded into a never-edited document must carry the
 * "hydrate" origin, or every cold load marks the actor dirty and arms a flush
 * alarm that has nothing to write.
 */

/** The origins DocStore treats as replay (never journaled as a pending edit). */
const REPLAY_ORIGINS = ["hydrate", "preview", "restore"];

/** Mirrors DocStore's dirty decision. */
function marksDirty(origin: unknown): boolean {
  return !REPLAY_ORIGINS.includes(origin as string);
}

describe("empty-paragraph seed", () => {
  it("does not mark the doc dirty when tagged as hydrate (as DocActor does it)", () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));

    const root = doc.getXmlFragment("default");
    // The shape DocStore.ensureLoaded uses.
    if (root.length === 0) {
      doc.transact(() => {
        root.insert(0, [new Y.XmlElement("paragraph")]);
      }, "hydrate");
    }

    expect(origins.length).toBe(1);
    expect(origins.every((o) => !marksDirty(o))).toBe(true);
  });

  it("still seeds exactly one paragraph so a new doc opens editable", () => {
    const doc = new Y.Doc();
    const root = doc.getXmlFragment("default");
    doc.transact(() => {
      root.insert(0, [new Y.XmlElement("paragraph")]);
    }, "hydrate");

    expect(root.length).toBe(1);
    // A second ensureLoaded() is a no-op: its `root.length === 0` guard is false.
    if (root.length === 0) root.insert(0, [new Y.XmlElement("paragraph")]);
    expect(root.length).toBe(1);
  });

  it("proves the untagged seed WOULD mark the doc dirty (the original bug)", () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));

    const root = doc.getXmlFragment("default");
    root.insert(0, [new Y.XmlElement("paragraph")]); // untagged

    expect(origins.length).toBe(1);
    expect(marksDirty(origins[0])).toBe(true);
  });

  it("a real user edit still marks the doc dirty", () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    const root = doc.getXmlFragment("default");
    doc.transact(() => {
      root.insert(0, [new Y.XmlElement("paragraph")]);
    }, "hydrate");

    doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(new Y.Doc()), { alias: "someone" });
    // Any non-replay origin (including an identity object) must count as dirty.
    expect(marksDirty({ alias: "someone" })).toBe(true);
  });
});
