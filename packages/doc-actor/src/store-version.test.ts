/**
 * What a document's store holds is pinned to DOC_STORE_VERSION: the keys it writes, the shape of
 * each value (checked by the type checker, since values are stored as they are typed), and the SQL
 * schema of its file as the real host leaves it. A change to any of them raises the version, with
 * the step in the host that brings an older store forward.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, type ActorHandle } from "@stuga/runtime";
import { storeSchema } from "@stuga/runtime/testing";
import { DocActor } from "./doc-actor.js";
import type { StoredRun } from "./ledger/run-store.js";
import type { RingState } from "./store/retention.js";
import { DOC_STORE_VERSION, type StoredMeta } from "./store/doc-store.js";
import { harness } from "../test/harness.js";

/**
 * Per version: the keys a store holds (`*` stands for a name or an id), and the fingerprint of its SQL
 * schema. A released version's entry never changes.
 */
const PINNED: Record<number, { keys: string[]; schema: string }> = {
  1: { keys: ["locked", "meta", "pending", "run-active:*", "run-order", "run:*"], schema: "f5c5bd82901d11de" },
};

const RAISE =
  "If that is meant, raise DOC_STORE_VERSION (packages/doc-actor/src/store/doc-store.ts), add the step in claimStoreVersion " +
  "(packages/runtime/src/actor-host.ts) that brings an older store forward, and pin the new store under the new version here.";

describe("a document's store", () => {
  it("keeps each value in the shape DOC_STORE_VERSION pins", () => {
    // A failure here is a type error. RAISE says what to do.
    expectTypeOf<StoredMeta>().toEqualTypeOf<{ docId: string; seq: number; epoch: number; ring: RingState }>();
    expectTypeOf<RingState>().toEqualTypeOf<{ seqs: number[]; lastAt: number; lastHash: string }>();
    expectTypeOf<StoredRun>().toEqualTypeOf<{
      id: string;
      doc_id: string;
      source: "connector" | "stdio" | "panel";
      agent: string;
      agent_alias: string;
      client?: string;
      model?: string;
      reviewer: string;
      status: "open" | "applied" | "rejected" | "expired";
      acknowledged: boolean;
      auto_applied: boolean;
      reverted?: boolean;
      review_mode: "review" | "auto";
      created_at: number;
      updated_at: number;
      seq_at_commit?: number;
      workspace_id: string;
      doc_title: string;
      blob_key: string;
      hunk_meta: { id: string; status: "pending" | "accepted" | "rejected" | "conflict" | "auto_applied"; bytes: number }[];
    }>();
  });

  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  async function call(doc: ActorHandle, path: string, body?: unknown): Promise<void> {
    const res = await doc.fetch(`http://actor${path}${path.includes("?") ? "&" : "?"}docId=doc1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  }

  it("holds the keys and the SQL schema DOC_STORE_VERSION pins", async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-doc-store-"));
    const ns = createActorNamespace(DocActor, harness().env, {
      name: "docs",
      heartbeat: { request: Heartbeat.PING, response: Heartbeat.PONG },
      dir,
      storeVersion: DOC_STORE_VERSION,
    });
    try {
      const doc = ns.get("doc1");
      await call(doc, "/apply-edits", { str_edits: [{ old_string: "", new_string: "# Notes\n\nAlpha.\n" }], agent: "seed" });
      await call(doc, "/runs/propose", {
        action: "str_replace",
        find: "Alpha.",
        replace: "Bravo.",
        source: "stdio",
        agent: "Claude",
        agent_alias: "agent1",
        reviewer: "alice",
        workspace_id: "ws1",
        doc_title: "Notes",
      });
      await call(doc, "/set-locked?locked=1");
    } finally {
      await ns.close();
    }

    const file = join(dir, "doc1.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    let keys: string[];
    try {
      keys = (db.prepare("SELECT key FROM _kv").all() as { key: string }[]).map((r) => r.key.replace(/:.*$/, ":*"));
    } finally {
      db.close();
    }
    const pinned = PINNED[DOC_STORE_VERSION]!;
    const unknown = [...new Set(keys)].filter((k) => !pinned.keys.includes(k)).sort();
    expect(unknown, `a document's store holds keys it did not: ${unknown.join(", ")}. ${RAISE}`).toEqual([]);
    expect(keys).toEqual(expect.arrayContaining(["meta", "run-order", "run:*", "run-active:*", "locked"]));
    const { schema, fingerprint } = storeSchema(file);
    expect(fingerprint, `a document's store has another SQL schema, ${fingerprint}:\n${schema}\n${RAISE}`).toBe(pinned.schema);
  });
});
