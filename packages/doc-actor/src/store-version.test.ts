/**
 * What a document's store holds is pinned to DOC_STORE_VERSION: the keys it writes, the shape of
 * each value (checked by the type checker, since values are stored as they are typed), and the SQL
 * schema of its file as the real host leaves it. A change to any of them raises the version, with
 * the step in the host that brings an older store forward. So does a new node or mark type in the
 * text, which an older build's schema cannot read: those are pinned from version 3 on.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

// A co-author thread turn writes a key of its own; the model is not what is under test.
vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAgentTurn: vi.fn(),
}));

const { runAgentTurn } = await import("@stuga/ai");

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AiEditsPayload, AiRequest } from "@stuga/protocol/wire/doc-socket";
import { encodeJson } from "@stuga/protocol/wire/frame";
import { Heartbeat, Opcode, TEXT_SCHEMA_VERSION } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, type ActorHandle } from "@stuga/runtime";
import { storeSchema } from "@stuga/runtime/testing";
import { getStugaSchema } from "@stuga/crdt-ops";
import type { StoredThreadOutcome } from "./coauthor/thread.js";
import { DocActor } from "./doc-actor.js";
import type { StoredRun } from "./ledger/run-store.js";
import type { RingState } from "./store/retention.js";
import { DOC_STORE_UPGRADES, DOC_STORE_VERSION, type StoredMeta } from "./store/doc-store.js";
import { connect, frameBuffer, harness, makeActor } from "../test/harness.js";
import { threadNode } from "../test/thread-node.js";

/**
 * Per version: the keys a store holds (`*` stands for a name or an id), and the fingerprint of its SQL
 * schema. A released version's entry never changes.
 */
const PINNED: Record<number, { keys: string[]; schema: string }> = {
  1: { keys: ["locked", "meta", "pending", "run-active:*", "run-order", "run:*"], schema: "f5c5bd82901d11de" },
  2: { keys: ["feedback-pending:*", "locked", "meta", "pending", "run-active:*", "run-order", "run:*"], schema: "d0ecfe622f413eda" },
  3: { keys: ["feedback-pending:*", "locked", "meta", "pending", "run-active:*", "run-order", "run:*"], schema: "ac9d0a3f63b2affa" },
  4: {
    keys: ["coauthor-clean:*", "coauthor-threads:*", "feedback-pending:*", "locked", "meta", "pending", "run-active:*", "run-order", "run:*"],
    schema: "d5faf519fff506b3",
  },
  // The `colleague` level on a run, with the approver group it was proposed under and who approved it.
  5: {
    keys: ["coauthor-clean:*", "coauthor-threads:*", "feedback-pending:*", "locked", "meta", "pending", "run-active:*", "run-order", "run:*"],
    schema: "0f08c4ae72761d0e",
  },
  // The change a run belongs to, and the run it waits behind.
  6: {
    keys: ["coauthor-clean:*", "coauthor-threads:*", "feedback-pending:*", "locked", "meta", "pending", "run-active:*", "run-order", "run:*"],
    schema: "8a5f1aba9e0e7676",
  },
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
  4: {
    nodes: [
      "blockquote", "bulletList", "codeBlock", "doc", "footnoteDefinition", "footnoteReference", "hardBreak", "heading",
      "horizontalRule", "image", "listItem", "mention", "orderedList", "paragraph", "table", "tableCell", "tableHeader",
      "tableRow", "taskItem", "taskList", "text",
    ],
    marks: ["bold", "code", "italic", "link", "strike", "underline"],
  },
  5: {
    nodes: [
      "blockquote", "bulletList", "codeBlock", "doc", "footnoteDefinition", "footnoteReference", "hardBreak", "heading",
      "horizontalRule", "image", "listItem", "mention", "orderedList", "paragraph", "table", "tableCell", "tableHeader",
      "tableRow", "taskItem", "taskList", "text",
    ],
    marks: ["bold", "code", "italic", "link", "strike", "underline"],
  },
  6: {
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
      review_mode: "auto" | "review" | "colleague";
      approver_group?: string;
      approvals?: Record<string, string>;
      change_id?: string;
      queued_behind?: string;
      stacked_on?: string[];
      created_at: number;
      updated_at: number;
      seq_at_commit?: number;
      workspace_id: string;
      doc_title: string;
      blob_key: string;
      hunk_meta: { id: string; status: "pending" | "accepted" | "rejected" | "conflict" | "auto_applied"; bytes: number }[];
    }>();
    // The receipt is the wire's own, which only ever gains optional fields: an older record reads as it is.
    expectTypeOf<StoredThreadOutcome>().toEqualTypeOf<{ key: string; edits: AiEditsPayload }>();
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
  it("keeps the outcome of a comment reply the co-author answered, and where its edits came from, under keys DOC_STORE_VERSION pins", async () => {
    const h = harness();
    threadNode(h, [
      { parent_num: null, author: "panel:liv", body: "Built-in or freestanding?" },
      { parent_num: 1, author: "liv", body: "Freestanding." },
    ]);
    vi.mocked(runAgentTurn).mockResolvedValue({
      prose: "Noted.",
      answer: "Noted.",
      strEdits: [{ old_string: "", new_string: "Freestanding." }],
      docEdits: [],
      citations: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      modelId: "test-model",
      rounds: 1,
      stopReason: "complete",
    });
    const doc = makeActor(h);
    const ws = await connect(doc, h, { docId: "doc1", alias: "liv" });
    const req: AiRequest = { prompt: "", selected_text: null, model: "auto", history: [], thread: { num: 1, reply_num: 2 } };
    await doc.webSocketMessage(ws, frameBuffer(encodeJson(Opcode.AI_REQUEST, req)));

    const keys = [...h.state.storage.map.keys()].map((k) => k.replace(/:.*$/, ":*"));
    expect(keys).toContain("coauthor-threads:*");
    expect(keys).toContain("coauthor-clean:*");
    const unknown = [...new Set(keys)].filter((k) => !PINNED[DOC_STORE_VERSION]!.keys.includes(k));
    expect(unknown, `a document's store holds keys it did not: ${unknown.join(", ")}. ${RAISE}`).toEqual([]);
  });

  it.each([3, 4])("brings a version %i store forward as it is", async (version) => {
    dir = mkdtempSync(join(tmpdir(), "stuga-doc-store-"));
    const env = harness().env;
    const older = namespace(version, undefined, env);
    let runId = "";
    try {
      const doc = older.get("doc1");
      await call(doc, "/apply-edits", { str_edits: [{ old_string: "", new_string: "# Notes\n\nAlpha.\n" }], agent: "seed" });
      runId = ((await call(doc, "/runs/propose", PROPOSAL)).run as { id: string }).id;
      await call(doc, "/runs/decide", { run_id: runId, decision: "reject", decided_by: "alice", note: "Keep Alpha." });
    } finally {
      await older.close();
    }

    const upgraded = namespace(DOC_STORE_VERSION, DOC_STORE_UPGRADES, env);
    try {
      const doc = upgraded.get("doc1");
      const listed = (await doc.fetch("http://actor/runs?docId=doc1").then((r) => r.json())) as { runs: Array<{ id: string; status: string }> };
      expect(listed.runs.map((r) => [r.id, r.status])).toEqual([[runId, "rejected"]]);
      const read = (await doc.fetch("http://actor/markdown?docId=doc1&agent=agent1").then((r) => r.json())) as { feedback?: Array<{ note: string }> };
      expect(read.feedback).toEqual([expect.objectContaining({ note: "Keep Alpha." })]);
    } finally {
      await upgraded.close();
    }
    const db = new DatabaseSync(join(dir, "doc1.sqlite"), { readOnly: true });
    try {
      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(DOC_STORE_VERSION);
    } finally {
      db.close();
    }
  });
});
