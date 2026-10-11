/**
 * What a document's store holds is pinned to DOC_STORE_VERSION: the keys it writes, the shape of
 * each value (checked by the type checker, since values are stored as they are typed), and the SQL
 * schema of its file as the real host leaves it. A change to any of them raises the version, with
 * the step in the host that brings an older store forward. So does a new node or mark type in the
 * text, which an older build's schema cannot read: those are pinned from version 3 on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { Heartbeat, TEXT_SCHEMA_VERSION } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, type ActorHandle } from "@stuga/runtime";
import { storeSchema } from "@stuga/runtime/testing";
import { getStugaSchema } from "@stuga/crdt-ops";
import { DocActor } from "./doc-actor.js";
import type { StoredRun } from "./ledger/run-store.js";
import type { RingState } from "./store/retention.js";
import { DOC_STORE_UPGRADES, DOC_STORE_VERSION, type StoredMeta } from "./store/doc-store.js";
import { harness } from "../test/harness.js";

/**
 * Per version: the keys a store holds (`*` stands for a name or an id), and the fingerprint of its SQL
 * schema. A released version's entry never changes.
 */
const PINNED: Record<number, { keys: string[]; schema: string }> = {
  1: { keys: ["locked", "meta", "pending", "run-active:*", "run-order", "run:*"], schema: "f5c5bd82901d11de" },
  2: { keys: ["feedback-pending:*", "locked", "meta", "pending", "run-active:*", "run-order", "run:*"], schema: "d0ecfe622f413eda" },
  3: { keys: ["feedback-pending:*", "locked", "meta", "pending", "run-active:*", "run-order", "run:*"], schema: "ac9d0a3f63b2affa" },
};

/** Per version from 3 on: the node and mark types the text may hold. A released version's entry never changes. */
const TEXT_TYPES: Record<number, { nodes: string[]; marks: string[] }> = {
  3: {
    nodes: [
      "blockquote", "bulletList", "codeBlock", "doc", "footnoteDefinition", "footnoteReference", "hardBreak", "heading",
      "horizontalRule", "image", "listItem", "mention", "orderedList", "paragraph", "table", "tableCell", "tableHeader",
      "tableRow", "taskItem", "taskList", "text",
    ],
    marks: ["bold", "code", "italic", "link", "strike", "underline"],
  },
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

  async function call(doc: ActorHandle, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await doc.fetch(`http://actor${path}${path.includes("?") ? "&" : "?"}docId=doc1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  const PROPOSAL = {
    action: "str_replace",
    find: "Alpha.",
    replace: "Bravo.",
    source: "stdio",
    agent: "Claude",
    agent_alias: "agent1",
    reviewer: "alice",
    workspace_id: "ws1",
    doc_title: "Notes",
  };

  const namespace = (version: number, upgrades?: Record<number, (db: DatabaseSync) => void>, env = harness().env) =>
    createActorNamespace(DocActor, env, {
      name: "docs",
      heartbeat: { request: Heartbeat.PING, response: Heartbeat.PONG },
      dir,
      storeVersion: version,
      ...(upgrades ? { storeUpgrades: upgrades } : {}),
    });

  it("holds text of the node and mark types DOC_STORE_VERSION pins", () => {
    const schema = getStugaSchema();
    expect(
      { nodes: Object.keys(schema.nodes).sort(), marks: Object.keys(schema.marks).sort() },
      `the text a document holds may have other node or mark types. ${RAISE}`,
    ).toEqual(TEXT_TYPES[DOC_STORE_VERSION]);
  });

  it("reloads a page whose editor predates the text types it may hold", () => {
    // TEXT_SCHEMA_VERSION is the store version that brought in the current text types.
    const current = JSON.stringify(TEXT_TYPES[DOC_STORE_VERSION]);
    const since = Math.min(...Object.keys(TEXT_TYPES).map(Number).filter((v) => JSON.stringify(TEXT_TYPES[v]) === current));
    expect(TEXT_SCHEMA_VERSION, "raise TEXT_SCHEMA_VERSION (packages/protocol/src/wire/opcodes.ts) with the text types").toBe(since);
  });

  it("holds the keys and the SQL schema DOC_STORE_VERSION pins", async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-doc-store-"));
    const ns = namespace(DOC_STORE_VERSION, DOC_STORE_UPGRADES);
    try {
      const doc = ns.get("doc1");
      await call(doc, "/apply-edits", { str_edits: [{ old_string: "", new_string: "# Notes\n\nAlpha.\n" }], agent: "seed" });
      const proposed = (await call(doc, "/runs/propose", PROPOSAL)).run as { id: string };
      // A rejection with a note lists the run for its agent, under a key of its own.
      await call(doc, "/runs/decide", { run_id: proposed.id, decision: "reject", decided_by: "alice", note: "Keep Alpha." });
      await call(doc, "/runs/propose", { ...PROPOSAL, find: "# Notes", replace: "# Notes 2" });
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
    expect(keys).toEqual(expect.arrayContaining(["meta", "run-order", "run:*", "run-active:*", "locked", "feedback-pending:*"]));
    const { schema, fingerprint } = storeSchema(file);
    expect(fingerprint, `a document's store has another SQL schema, ${fingerprint}:\n${schema}\n${RAISE}`).toBe(pinned.schema);
  });

  it("brings a version 1 store forward, keeping its runs, and a rejection with a note works in it", async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-doc-store-"));
    const file = join(dir, "doc1.sqlite");
    const stamp = () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      } finally {
        db.close();
      }
    };

    // Written by a version 1 build: a document with one proposal waiting. The run's body lives in the
    // blob store, which the upgraded build shares.
    const env = harness().env;
    const v1 = namespace(1, undefined, env);
    let runId = "";
    try {
      const doc = v1.get("doc1");
      await call(doc, "/apply-edits", { str_edits: [{ old_string: "", new_string: "# Notes\n\nAlpha.\n" }], agent: "seed" });
      runId = ((await call(doc, "/runs/propose", PROPOSAL)).run as { id: string }).id;
    } finally {
      await v1.close();
    }
    expect(stamp()).toBe(1);

    const upgraded = namespace(DOC_STORE_VERSION, DOC_STORE_UPGRADES, env);
    try {
      const doc = upgraded.get("doc1");
      const listed = (await doc.fetch("http://actor/runs?docId=doc1").then((r) => r.json())) as { runs: Array<{ id: string; status: string }> };
      expect(listed.runs.map((r) => [r.id, r.status])).toEqual([[runId, "open"]]);
      await call(doc, "/runs/decide", { run_id: runId, decision: "reject", decided_by: "alice", note: "Keep Alpha." });
      const read = (await doc.fetch("http://actor/markdown?docId=doc1&agent=agent1").then((r) => r.json())) as { feedback?: Array<{ note: string }> };
      expect(read.feedback).toEqual([expect.objectContaining({ note: "Keep Alpha." })]);
    } finally {
      await upgraded.close();
    }
    expect(stamp()).toBe(DOC_STORE_VERSION);
  });
});
