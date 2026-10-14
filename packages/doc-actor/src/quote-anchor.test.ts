/**
 * Where a passage an agent quotes sits in the live document: the node anchors the agent's comment
 * with the answer. The actor only reads; the node decides what counts as found.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decodeRelPos, type QuoteAnchor } from "@stuga/crdt-ops";
import type { DocActor } from "./doc-actor.js";
import { harness, makeActor } from "../test/harness.js";

const DOC = "doc1";
const SEEDED = "# Bathroom\n\nThe **bathtub** is built-in.\n\nTiles: white.\n\nGrout: white.\n";

async function seeded(): Promise<DocActor> {
  const actor = makeActor(harness());
  await actor.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: "", new_string: SEEDED }], agent: "seed" }),
    }),
  );
  return actor;
}

const ANCHOR_URL = `http://actor/quote-anchor?docId=${DOC}`;

function ask(actor: DocActor, body: unknown): Promise<Response> {
  return actor.fetch(new Request(ANCHOR_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

async function anchorOf(actor: DocActor, quote: string): Promise<QuoteAnchor | null> {
  const res = await ask(actor, { quote });
  expect(res.status).toBe(200);
  return ((await res.json()) as { anchor: QuoteAnchor | null }).anchor;
}

describe("/quote-anchor", () => {
  it("pins a passage the document has once, across its formatting", async () => {
    const actor = await seeded();
    const anchor = await anchorOf(actor, "bathtub is built-in");
    expect(anchor).toMatchObject({ quote: "bathtub is built-in" });
    expect(decodeRelPos(anchor!.start!)).toBeInstanceOf(Y.RelativePosition);
    expect(decodeRelPos(anchor!.end!)).toBeInstanceOf(Y.RelativePosition);
  });

  it("finds nothing for text that is missing or there twice", async () => {
    const actor = await seeded();
    expect(await anchorOf(actor, "shower")).toBeNull();
    expect(await anchorOf(actor, "white")).toBeNull();
  });

  it("answers the document's own text where typography differs, for the node to hold to the quote", async () => {
    const actor = await seeded();
    const anchor = await anchorOf(actor, "bathtub is built‑in");
    expect(anchor?.quote).toBe("bathtub is built-in");
  });

  it("leaves the document as it was", async () => {
    const actor = await seeded();
    const before = await (await actor.fetch(new Request(`http://actor/markdown?docId=${DOC}`))).json();
    await anchorOf(actor, "bathtub");
    expect(await (await actor.fetch(new Request(`http://actor/markdown?docId=${DOC}`))).json()).toEqual(before);
  });

  it("refuses a request with no quote, and any method but POST", async () => {
    const actor = await seeded();
    expect((await ask(actor, {})).status).toBe(400);
    expect((await ask(actor, { quote: "" })).status).toBe(400);
    expect((await ask(actor, { quote: 7 })).status).toBe(400);
    expect((await actor.fetch(new Request(ANCHOR_URL))).status).toBe(405);
  });
});
