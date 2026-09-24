/**
 * The server-side table growth ceiling. Editors that pad ragged tables can feed
 * each other ever-wider tables through the CRDT; the refusals hold for any
 * client, whatever its editor does.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeBinary, decodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { MAX_TABLE_COLS, MAX_TABLE_ROWS, MAX_TABLE_GROWTH_PER_WINDOW } from "@stuga/protocol/domain/limits";
import {
  harness,
  makeActor,
  connect,
  type MemorySocket,
  frameBuffer,
} from "../test/harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(dobj: any, ws: MemorySocket, update: Uint8Array): Promise<void> {
  const frame = encodeBinary(Opcode.UPDATE, update);
  await dobj.webSocketMessage(ws, frameBuffer(frame));
}

/** Build a table node with `rows` × `cols` cells (the shape tiptap/Stuga emits). */
function tableElement(rows: number, cols: number): Y.XmlElement {
  const table = new Y.XmlElement("table");
  for (let r = 0; r < rows; r++) {
    const row = new Y.XmlElement("tableRow");
    for (let c = 0; c < cols; c++) {
      const cell = new Y.XmlElement("tableCell");
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText(`r${r}c${c}`)]);
      cell.insert(0, [p]);
      row.insert(c, [cell]);
    }
    table.insert(r, [row]);
  }
  return table;
}

/** A client doc holding one table, plus the update that creates it. */
function tableUpdate(rows: number, cols: number): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getXmlFragment("default").insert(0, [tableElement(rows, cols)]);
  });
  return { doc, update: Y.encodeStateAsUpdate(doc) };
}

/** Widen the first table in `doc` by `extra` columns; return just that delta. */
function widen(doc: Y.Doc, extra: number): Uint8Array {
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    const table = doc.getXmlFragment("default").get(0) as Y.XmlElement;
    for (let r = 0; r < table.length; r++) {
      const row = table.get(r) as Y.XmlElement;
      for (let i = 0; i < extra; i++) {
        const cell = new Y.XmlElement("tableCell");
        cell.insert(0, [new Y.XmlElement("paragraph")]);
        row.insert(row.length, [cell]);
      }
    }
  });
  return Y.encodeStateAsUpdate(doc, before);
}

/** A plain-prose update (no table structure anywhere). */
function proseUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  return Y.encodeStateAsUpdate(doc);
}

function rejection(ws: MemorySocket): string | null {
  const payload = ws.firstPayload(Opcode.WRITE_REJECTED);
  return payload ? decodeJson<{ kind: string }>(payload).kind : null;
}

const DOC = "doc-table-test";
const CONNECT = { docId: DOC, alias: "alice", write: "1" };

describe("table cap", () => {
  it("accepts an ordinary table", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await send(dobj, ws, tableUpdate(3, 4).update);
    expect(rejection(ws)).toBeNull();
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(true);
  });

  it("refuses a table over the column cap", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await send(dobj, ws, tableUpdate(2, MAX_TABLE_COLS + 1).update);
    expect(rejection(ws)).toBe("table-cap");
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(false);
  });

  it("refuses a table over the row cap", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await send(dobj, ws, tableUpdate(MAX_TABLE_ROWS + 1, 2).update);
    expect(rejection(ws)).toBe("table-cap");
  });

  it("does not integrate a refused update (the CRDT stays clean)", async () => {
    // The whole point of deciding BEFORE the apply: a Yjs integration cannot be
    // undone, so a table that lands is permanent and has already been broadcast.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await send(dobj, ws, tableUpdate(2, MAX_TABLE_COLS + 1).update);
    await dobj.alarm();

    // Read the LIVE fragment: a refused update leaves the actor clean, so there
    // is no snapshot to inspect and a snapshot-only check asserts nothing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((dobj as any).store.doc.getXmlFragment("default").toString()).not.toContain("<table>");
    // And nothing was fanned out to peers.
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(false);
  });

  it("refuses growth that would push an EXISTING table over the cap", async () => {
    // The cap is about the resulting document, not the size of the update. A 2-column
    // delta landing on a 63-column table is the case that actually matters — and it's
    // exactly the shape the fixTables cascade produces.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);

    const { doc, update } = tableUpdate(2, MAX_TABLE_COLS - 1);
    await send(dobj, ws, update);
    expect(rejection(ws)).toBeNull();

    await send(dobj, ws, widen(doc, 2)); // → MAX + 1
    expect(rejection(ws)).toBe("table-cap");
  });

  it("allows growth that stays within the cap", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const { doc, update } = tableUpdate(2, 4);
    await send(dobj, ws, update);
    await send(dobj, ws, widen(doc, 2));
    expect(rejection(ws)).toBeNull();
  });
});

describe("structural rate", () => {
  it("refuses sustained table growth from one connection", async () => {
    // Each step widens the same table by one column — the cascade's signature. Every
    // individual update is far under the dimension cap, which is how the loop climbs;
    // the rate limit is what catches it.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const { doc, update } = tableUpdate(2, 2);
    await send(dobj, ws, update);

    let kind: string | null = null;
    for (let i = 0; i < MAX_TABLE_GROWTH_PER_WINDOW + 5; i++) {
      await send(dobj, ws, widen(doc, 1));
      kind = rejection(ws);
      if (kind) break;
    }
    // Either refusal is correct here (the cap may bite first depending on the
    // constants); what must NOT happen is unbounded acceptance.
    expect(kind === "structural-rate" || kind === "table-cap").toBe(true);
  });

  it("does NOT throttle ordinary typing", async () => {
    // The budget is consumed only by table-GROWING updates, so a fast typist never
    // trips it — the guard has to be invisible in normal use to be acceptable.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);

    const doc = new Y.Doc();
    doc.transact(() => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText("x")]);
      doc.getXmlFragment("default").insert(0, [p]);
    });
    await send(dobj, ws, Y.encodeStateAsUpdate(doc));

    for (let i = 0; i < MAX_TABLE_GROWTH_PER_WINDOW * 2; i++) {
      const before = Y.encodeStateVector(doc);
      doc.transact(() => {
        const p = doc.getXmlFragment("default").get(0) as Y.XmlElement;
        (p.get(0) as Y.XmlText).insert(0, "y");
      });
      await send(dobj, ws, Y.encodeStateAsUpdate(doc, before));
    }
    expect(rejection(ws)).toBeNull();
  });

  it("does NOT throttle typing INSIDE an existing table", async () => {
    // Editing cell text doesn't change dimensions, so it must not consume the
    // structural budget — otherwise working in a table would throttle itself.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const { doc, update } = tableUpdate(3, 3);
    await send(dobj, ws, update);

    for (let i = 0; i < MAX_TABLE_GROWTH_PER_WINDOW * 2; i++) {
      const before = Y.encodeStateVector(doc);
      doc.transact(() => {
        const table = doc.getXmlFragment("default").get(0) as Y.XmlElement;
        const cell = (table.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
        const p = cell.get(0) as Y.XmlElement;
        (p.get(0) as Y.XmlText).insert(0, "z");
      });
      await send(dobj, ws, Y.encodeStateAsUpdate(doc, before));
    }
    expect(rejection(ws)).toBeNull();
  });
});

describe("content fast path", () => {
  it("lets prose through without the dimension scan", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await send(dobj, ws, proseUpdate("just words"));
    expect(rejection(ws)).toBeNull();
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(true);
  });

  it("still catches a MINIMAL table-creating update", async () => {
    // A tiny over-cap table must be refused however few bytes it takes: the fast
    // path keys on the "table" tag, never on update size.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);

    // One row, over the column cap, with empty cells: as small as this gets.
    const doc = new Y.Doc();
    doc.transact(() => {
      const table = new Y.XmlElement("table");
      const row = new Y.XmlElement("tableRow");
      for (let c = 0; c < MAX_TABLE_COLS + 1; c++) row.insert(c, [new Y.XmlElement("tableCell")]);
      table.insert(0, [row]);
      doc.getXmlFragment("default").insert(0, [table]);
    });
    await send(dobj, ws, Y.encodeStateAsUpdate(doc));
    expect(rejection(ws)).toBe("table-cap");
  });

  it("prose containing the word \"table\" is accepted (a false positive is only slower)", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await send(dobj, ws, proseUpdate("the table of contents"));
    expect(rejection(ws)).toBeNull();
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(true);
  });
});
