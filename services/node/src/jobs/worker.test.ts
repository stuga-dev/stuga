import { describe, expect, it, vi } from "vitest";
import { AiError } from "@stuga/ai";
import * as Y from "yjs";
import { applyMarkdownToYXmlFragment } from "@stuga/crdt-ops";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { JobBatch, JobMessage } from "@stuga/db";
import type { BlobStore } from "@stuga/runtime";
import type { JobsDb } from "./db.js";
import { isTerminal, type JobsEnv } from "./deps.js";
import { runMaintenanceTick } from "./maintenance.js";
import type { NotificationPayload } from "./sinks.js";
import { auditRow, dispatchJob, handleJobBatch, type AuditMessage } from "./worker.js";

/** A JobsDb whose every member is a spy with a benign default. */
function fakeDb(overrides: Partial<JobsDb> = {}): JobsDb {
  const base: JobsDb = {
    getDoc: vi.fn(async () => null),
    previousVersionSeq: vi.fn(async () => null),
    recordVersion: vi.fn(async () => {}),
    clearDocChunks: vi.fn(async () => {}),
    getEmbeddingHash: vi.fn(async () => null),
    getReusableChunkEmbeddings: vi.fn(async () => new Map()),
    insertAiUsage: vi.fn(async () => {}),
    indexDoc: vi.fn(async () => {}),
    insertNotification: vi.fn(async () => true),
    insertAuditEvents: vi.fn(async () => {}),
    userEmail: vi.fn(async () => null),
    displayNameOf: vi.fn(async () => null),
    syncDocMentions: vi.fn(async () => []),
    mentionReaders: vi.fn(async (_doc: unknown, aliases: string[]) => aliases),
    findChunksMissingEmbeddings: vi.fn(async () => []),
    setChunkEmbedding: vi.fn(async () => {}),
    bumpChunkEmbedAttempt: vi.fn(async () => {}),
    listWorkspacesAwaitingBackfill: vi.fn(async () => []),
    listDocsNeedingEmbeddingBackfill: vi.fn(async () => []),
    advanceEmbeddingBackfill: vi.fn(async () => {}),
    findExpiredTrash: vi.fn(async () => []),
    trashPagesOf: vi.fn(async () => []),
    queueSnapshotSweep: vi.fn(async () => {}),
    deleteDoc: vi.fn(async () => {}),
    purgeRevokedApiKeys: vi.fn(async () => 0),
    purgeUnusedOauthClients: vi.fn(async () => 0),
    purgeOldNotifications: vi.fn(async () => 0),
    purgeAuditEvents: vi.fn(async () => 0),
    purgeAiUsage: vi.fn(async () => 0),
    purgeAskThreads: vi.fn(async () => 0),
    purgeRefreshSessions: vi.fn(async () => 0),
    purgePasswordResets: vi.fn(async () => 0),
    purgeOidcSignIns: vi.fn(async () => 0),
  } as unknown as JobsDb;
  return { ...base, ...overrides };
}

function fakeBlobStore(keys: string[] = []): BlobStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    get: async () => null,
    head: async () => null,
    put: async () => {},
    async delete(key) {
      deleted.push(...(Array.isArray(key) ? key : [key]));
    },
    async list(opts) {
      const objects = keys
        .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
        .map((key) => ({ key, size: 1, uploaded: new Date() }));
      return { objects, truncated: false };
    },
  };
}

function fakeEnv(overrides: Partial<JobsEnv> = {}): JobsEnv {
  return {
    sql: (() => {
      throw new Error("tests must not touch sql directly");
    }) as unknown as JobsEnv["sql"],
    snapshots: fakeBlobStore(),
    jobs: { send: vi.fn(async () => {}) },
    docs: { get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(null, { status: 200 })) })) },
    databases: { get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(null, { status: 200 })) })) },
    aiSettings: fixedStore({
      enabled: false,
      chat: { enabled: true, defaultModel: "m", endpoints: [{ id: "default", provider: "ollama", baseUrl: "x", models: [{ id: "m", name: "m" }] }] },
      embed: { enabled: true, provider: "ollama", baseUrl: "x", model: "m", dims: 4, searchMaxDistance: 0.6, retrievalMaxDistance: 0.9 },
    }),
    settings: nodeSettings(),
    publicOrigin: "http://localhost:8787",
    embeddingDims: 4,
    ...overrides,
  };
}

function fixedStore<T>(value: T): { current: () => T; secrets: () => never; refresh: () => Promise<void> } {
  return { current: () => value, secrets: () => ({}) as never, refresh: async () => {} };
}

function nodeSettings(overrides: Partial<ReturnType<JobsEnv["settings"]["current"]>> = {}): JobsEnv["settings"] {
  return fixedStore({
    nodeName: null,
    nodeLabel: "localhost",
    maxUploadBytes: 0,
    maxBodyBytes: 0,
    auditRetentionDays: 180,
    databaseOpsKeep: 500,
    aiUsageRetentionDays: 365,
    askThreadRetentionDays: 365,
    notify: { sink: "none" },
    branding: { accentColor: null },
    updateCheck: true,
    backups: { auto: true, hour: 3 },
    timeZone: "UTC",
    identityProvider: null,
    ...overrides,
  });
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function message<T extends IndexMessage>(body: T): JobMessage<IndexMessage> & { acked: () => boolean; retried: () => boolean } {
  let acked = false;
  let retried = false;
  return {
    id: Math.random().toString(36).slice(2),
    body,
    attempts: 1,
    ack: () => (acked = true),
    retry: () => (retried = true),
    acked: () => acked,
    retried: () => retried,
  };
}

function batchOf(messages: JobMessage<IndexMessage>[]): JobBatch<IndexMessage> {
  return {
    messages,
  };
}

const AT = "2026-09-06T10:00:00.000Z";

const audit = (action: string): AuditMessage => ({
  kind: "audit",
  at: AT,
  workspaceId: "w1",
  actor: "u_a",
  actorKind: "human",
  source: "web",
  action,
  status: "ok",
});

describe("auditRow", () => {
  it("maps the message onto an insert row, dropping absent optionals", () => {
    expect(auditRow(audit("doc.create"))).toEqual({
      workspaceId: "w1",
      actor: "u_a",
      actorKind: "human",
      source: "web",
      action: "doc.create",
      at: AT,
      status: "ok",
    });
    const full = auditRow({
      ...audit("doc.share"),
      onBehalfOf: "u_b",
      targetKind: "doc",
      targetId: "d1",
      requestId: "r1",
      detail: { to: "u_c" },
    });
    expect(full).toMatchObject({ onBehalfOf: "u_b", targetKind: "doc", targetId: "d1", requestId: "r1", detail: { to: "u_c" } });
  });

  it("carries the target's name and the outcome through to the row", () => {
    expect(
      auditRow({ ...audit("access.denied"), targetKind: "route", targetId: "/api/keys", targetLabel: null, status: "denied" }),
    ).toMatchObject({ targetLabel: null, status: "denied" });

    expect(auditRow({ ...audit("key.create"), targetLabel: "CI runner" })).toMatchObject({ targetLabel: "CI runner" });
  });

  it("carries the sender's timestamp through", () => {
    expect(auditRow({ ...audit("doc.create"), at: "2026-09-07T11:00:00.000Z" })).toMatchObject({ at: "2026-09-07T11:00:00.000Z" });
  });
});

describe("handleJobBatch", () => {
  it("writes every audit message of a batch with one insert and acks them", async () => {
    const db = fakeDb();
    const m1 = message(audit("a"));
    const m2 = message(audit("b"));
    const other = message({ kind: "gc_check", docId: "d1" });
    await handleJobBatch(fakeEnv(), batchOf([m1, other, m2]), { db, log: silentLog });
    expect(db.insertAuditEvents).toHaveBeenCalledTimes(1);
    expect(db.insertAuditEvents).toHaveBeenCalledWith([auditRow(m1.body as AuditMessage), auditRow(m2.body as AuditMessage)]);
    expect(m1.acked() && m2.acked() && other.acked()).toBe(true);
  });

  it("retries the whole audit slice when the insert fails", async () => {
    const db = fakeDb({ insertAuditEvents: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const m = message(audit("a"));
    await handleJobBatch(fakeEnv(), batchOf([m]), { db, log: silentLog });
    expect(m.retried()).toBe(true);
    expect(m.acked()).toBe(false);
  });

  it("acks a terminal failure (it would fail identically on retry) and retries a transient one", async () => {
    const terminal = message({ kind: "ai_usage", alias: "u_a", workspaceId: "ws1", docId: null, usageKind: "embedding", model: "m" });
    const transient = message({ kind: "ai_usage", alias: "u_b", workspaceId: "ws1", docId: null, usageKind: "embedding", model: "m" });
    const db = fakeDb({
      insertAiUsage: vi
        .fn()
        .mockRejectedValueOnce(new AiError("bad request", 400, false))
        .mockRejectedValueOnce(new Error("connection reset")),
    });
    await handleJobBatch(fakeEnv(), batchOf([terminal, transient]), { db, log: silentLog });
    expect(terminal.acked()).toBe(true);
    expect(terminal.retried()).toBe(false);
    expect(transient.retried()).toBe(true);
    expect(transient.acked()).toBe(false);
  });
});

describe("isTerminal", () => {
  it("only a non-retryable AiError is terminal", () => {
    expect(isTerminal(new AiError("bad request", 400, false))).toBe(true);
    expect(isTerminal(new AiError("overloaded", 429, true))).toBe(false);
    expect(isTerminal(new Error("anything else"))).toBe(false);
  });
});

describe("gc_check", () => {
  it("deletes every snapshot under the document's prefix and nothing else", async () => {
    const snapshots = fakeBlobStore(["d1/1.bin", "d1/2.bin", "d10/1.bin"]);
    await dispatchJob(fakeEnv({ snapshots }), { kind: "gc_check", docId: "d1" }, { db: fakeDb(), log: silentLog });
    expect(snapshots.deleted.sort()).toEqual(["d1/1.bin", "d1/2.bin"]);
  });

  it("leaves the snapshots of a document whose delete did not happen", async () => {
    const snapshots = fakeBlobStore(["d1/1.bin"]);
    const db = fakeDb({ getDoc: vi.fn(async () => ({ doc_id: "d1" }) as never) });
    await dispatchJob(fakeEnv({ snapshots }), { kind: "gc_check", docId: "d1" }, { db, log: silentLog });
    expect(db.getDoc).toHaveBeenCalledWith("d1");
    expect(snapshots.deleted).toEqual([]);
  });
});

describe("notify", () => {
  const notifyMsg: IndexMessage = {
    kind: "notify",
    docId: "d1",
    recipient: "u_r",
    workspaceId: "w1",
    eventType: "doc_shared",
    title: "Q3 plan",
    body: "Ada shared a document with you",
    actor: "u_a",
  };

  const deliverMsg: IndexMessage = {
    kind: "notify_deliver",
    recipient: "u_r",
    title: "Q3 plan",
    body: "Ada shared a document with you",
    url: "http://localhost:8787/doc/d1",
  };

  it("stores the notification with its sink delivery queued beside it, delivering nothing itself", async () => {
    const db = fakeDb();
    const deliver = vi.fn(async () => {});
    const m = message(notifyMsg);
    await handleJobBatch(fakeEnv({ settings: nodeSettings({ notify: { sink: "webhook", webhookUrl: "http://sink" } }) }), batchOf([m]), {
      db,
      log: silentLog,
      deliver,
    });
    expect(db.insertNotification).toHaveBeenCalledTimes(1);
    expect(db.insertNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_alias: "u_r", event_type: "doc_shared", resource_url: "http://localhost:8787/doc/d1" }),
      deliverMsg,
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(m.acked()).toBe(true);
  });

  it("queues no delivery when no sink is configured", async () => {
    const db = fakeDb();
    await handleJobBatch(fakeEnv(), batchOf([message(notifyMsg)]), { db, log: silentLog, deliver: vi.fn(async () => {}) });
    expect(db.insertNotification).toHaveBeenCalledWith(expect.objectContaining({ recipient_alias: "u_r" }), null);
  });

  it("hands a queued delivery to the sink", async () => {
    const delivered: NotificationPayload[] = [];
    await handleJobBatch(fakeEnv({ settings: nodeSettings({ notify: { sink: "webhook", webhookUrl: "http://sink" } }) }), batchOf([message(deliverMsg)]), {
      db: fakeDb(),
      log: silentLog,
      deliver: async (_cfg, n) => void delivered.push(n),
    });
    expect(delivered).toEqual([{ recipient: "u_r", title: "Q3 plan", body: "Ada shared a document with you", url: "http://localhost:8787/doc/d1" }]);
  });

  it("retries a failed delivery on its own, without storing the notification again", async () => {
    const db = fakeDb();
    const m = message(deliverMsg);
    await handleJobBatch(fakeEnv({ settings: nodeSettings({ notify: { sink: "slack", webhookUrl: "http://sink" } }) }), batchOf([m]), {
      db,
      log: silentLog,
      deliver: async () => Promise.reject(new Error("notification sink answered 429")),
    });
    expect(m.retried()).toBe(true);
    expect(m.acked()).toBe(false);
    expect(db.insertNotification).not.toHaveBeenCalled();
  });

  it("the email sink gets the recipient's directory email", async () => {
    const db = fakeDb({ userEmail: vi.fn(async () => "r@example.com") });
    const delivered: NotificationPayload[] = [];
    await handleJobBatch(
      fakeEnv({ settings: nodeSettings({ notify: { sink: "email", smtpUrl: "smtp://h", emailFrom: "stuga@example.com" } }) }),
      batchOf([message(deliverMsg)]),
      { db, log: silentLog, deliver: async (_cfg, n) => void delivered.push(n) },
    );
    expect(delivered[0]?.recipientEmail).toBe("r@example.com");
  });
});

describe("runMaintenanceTick", () => {
  it("hard-deletes expired trash: pages trashed, snapshot sweeps queued, rows deleted, then every actor destroyed", async () => {
    const destroy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    const namespace = () => ({ get: vi.fn(() => ({ fetch: destroy })) });
    const env = fakeEnv({ docs: namespace(), databases: namespace() } as unknown as Partial<JobsEnv>);
    const db = fakeDb({
      findExpiredTrash: vi.fn(async () => [
        { doc_id: "d_prose", doc_type: "prose" as const },
        { doc_id: "d_table", doc_type: "database" as const },
      ]),
      trashPagesOf: vi.fn(async () => ["p_loose"]),
    });
    await runMaintenanceTick(env, { db, log: silentLog });
    expect(destroy.mock.calls.map(([url]) => url)).toEqual(["http://actor/destroy?docId=d_prose", "http://actor/destroy?dbId=d_table"]);
    expect(db.trashPagesOf).toHaveBeenCalledTimes(1);
    expect(db.trashPagesOf).toHaveBeenCalledWith("d_table");
    const deleteDoc = db.deleteDoc as ReturnType<typeof vi.fn>;
    const sweep = db.queueSnapshotSweep as ReturnType<typeof vi.fn>;
    expect(deleteDoc.mock.calls.map(([id]) => id)).toEqual(["d_prose", "d_table"]);
    expect(sweep.mock.calls.map(([id]) => id)).toEqual(["d_prose", "d_table"]);
    // Per document: pages before the row, the sweep before the row, the row before the actor.
    expect((db.trashPagesOf as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(deleteDoc.mock.invocationCallOrder[1]!);
    for (const n of [0, 1]) {
      expect(sweep.mock.invocationCallOrder[n]!).toBeLessThan(deleteDoc.mock.invocationCallOrder[n]!);
      expect(deleteDoc.mock.invocationCallOrder[n]!).toBeLessThan(destroy.mock.invocationCallOrder[n]!);
    }
  });

  it("leaves an expired document in place when its snapshot sweep cannot be queued", async () => {
    const destroy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    const env = fakeEnv({ docs: { get: vi.fn(() => ({ fetch: destroy })) } } as unknown as Partial<JobsEnv>);
    const db = fakeDb({
      findExpiredTrash: vi.fn(async () => [{ doc_id: "d_prose", doc_type: "prose" as const }]),
      queueSnapshotSweep: vi.fn(async () => Promise.reject(new Error("jobs insert failed"))),
    });
    await runMaintenanceTick(env, { db, log: silentLog });
    expect(db.deleteDoc).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("purges audit rows with the configured retention and survives a failing stage", async () => {
    const db = fakeDb({
      findExpiredTrash: vi.fn(async () => Promise.reject(new Error("trash unavailable"))),
      purgeAuditEvents: vi.fn(async () => 3),
    });
    await runMaintenanceTick(fakeEnv({ settings: nodeSettings({ auditRetentionDays: 30 }) }), { db, log: silentLog });
    expect(db.purgeAuditEvents).toHaveBeenCalledWith(30);
  });

  it("sweeps expired import stagings from the snapshot store", async () => {
    const snapshots = fakeBlobStore(["db-imports/db1/imp_1_000000000000000000.meta", "d1/1.bin"]);
    await runMaintenanceTick(fakeEnv({ snapshots }), { db: fakeDb(), log: silentLog });
    expect(snapshots.deleted).toEqual(["db-imports/db1/imp_1_000000000000000000.meta"]);
  });

  it("purges AI usage rows and idle ask threads with their retention, and skips every ledger kept at 0", async () => {
    const db = fakeDb({ purgeAiUsage: vi.fn(async () => 2), purgeAskThreads: vi.fn(async () => 1) });
    await runMaintenanceTick(fakeEnv({ settings: nodeSettings({ aiUsageRetentionDays: 90, askThreadRetentionDays: 400 }) }), { db, log: silentLog });
    expect(db.purgeAiUsage).toHaveBeenCalledWith(90);
    expect(db.purgeAskThreads).toHaveBeenCalledWith(400);

    const kept = fakeDb();
    await runMaintenanceTick(
      fakeEnv({ settings: nodeSettings({ auditRetentionDays: 0, aiUsageRetentionDays: 0, askThreadRetentionDays: 0 }) }),
      { db: kept, log: silentLog },
    );
    expect(kept.purgeAuditEvents).not.toHaveBeenCalled();
    expect(kept.purgeAiUsage).not.toHaveBeenCalled();
    expect(kept.purgeAskThreads).not.toHaveBeenCalled();
  });

});

describe("index_doc: the version half", () => {
  /** A snapshot store holding one document's encoded state under `key`. */
  function snapshotStore(key: string, markdown: string): BlobStore {
    const doc = new Y.Doc();
    applyMarkdownToYXmlFragment(doc.getXmlFragment("default"), markdown);
    const bytes = Y.encodeStateAsUpdate(doc);
    return {
      get: async (k: string) => (k === key ? ({ arrayBuffer: async () => bytes.buffer } as unknown as Blob) : null),
      head: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as BlobStore;
  }

  const DOC = { doc_id: "d1", title: "Notes", title_source: "heading", search_hidden: false } as never;
  const KEY = "d1/7.bin";

  function fixture(recordVersion: boolean | undefined): { db: ReturnType<typeof fakeDb>; env: ReturnType<typeof fakeEnv>; msg: IndexMessage } {
    const db = fakeDb({ getDoc: vi.fn(async () => DOC) });
    const env = fakeEnv({ snapshots: snapshotStore(KEY, "# Notes\n\nbody") });
    const msg = {
      kind: "index_doc" as const,
      docId: "d1",
      snapshotSeq: 7,
      title: "Notes",
      authors: ["user:alice"],
      ...(recordVersion === true
        ? { recordVersion: true as const, versionFloor: 3 }
        : recordVersion === false
          ? { recordVersion: false as const }
          : {}),
    };
    return { db, env, msg };
  }

  it("records a version when the actor asked for one", async () => {
    const { db, env, msg } = fixture(true);
    await dispatchJob(env, msg, { db, log: silentLog });
    expect(db.recordVersion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.recordVersion).mock.calls[0]![0]).toMatchObject({ docId: "d1", seq: 7, blobKey: KEY, versionFloor: 3 });
  });

  it("indexes without recording a version when the actor did not ask", async () => {
    const { db, env, msg } = fixture(false);
    await dispatchJob(env, msg, { db, log: silentLog });
    expect(db.recordVersion).not.toHaveBeenCalled();
    expect(db.indexDoc).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a producer that sets no flag at all", async () => {
    const { db, env, msg } = fixture(undefined);
    await dispatchJob(env, msg, { db, log: silentLog });
    expect(db.recordVersion).not.toHaveBeenCalled();
  });
});

describe("index_doc: mentions", () => {
  function snapshotStore(key: string, markdown: string): BlobStore {
    const doc = new Y.Doc();
    applyMarkdownToYXmlFragment(doc.getXmlFragment("default"), markdown);
    const bytes = Y.encodeStateAsUpdate(doc);
    return {
      get: async (k: string) => (k === key ? ({ arrayBuffer: async () => bytes.buffer } as unknown as Blob) : null),
      head: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as BlobStore;
  }

  const BODY = "# Plan\n\n- Owner: [@bob](mention:u_bob) and [@cy](mention:u_cy)\n\nAlso [@bob](mention:u_bob) again.";
  const doc = (over: Record<string, unknown> = {}) =>
    ({ doc_id: "d1", workspace_id: "ws1", title: "Plan", title_source: "heading", search_hidden: true, trashed: false, acl_principals: ["org:ws1"], ...over }) as never;
  const msg = (authors: string[]): IndexMessage => ({ kind: "index_doc", docId: "d1", snapshotSeq: 3, title: "Plan", authors });

  function setup(added: string[], over: Record<string, unknown> = {}) {
    const db = fakeDb({
      getDoc: vi.fn(async () => doc(over)),
      syncDocMentions: vi.fn(async () => added),
      displayNameOf: vi.fn(async (a: string) => (a === "alice" ? "Alice A" : null)),
    });
    const env = fakeEnv({ snapshots: snapshotStore("d1/3.bin", BODY) });
    return { db, env, sent: () => vi.mocked(env.jobs.send).mock.calls.map((c) => c[0] as Extract<IndexMessage, { kind: "notify" }>) };
  }

  it("syncs every mentioned alias once and notifies the newly mentioned, even for a search-hidden doc", async () => {
    const { db, env, sent } = setup(["u_cy"]);
    await dispatchJob(env, msg(["user:alice"]), { db, log: silentLog });
    expect(db.syncDocMentions).toHaveBeenCalledWith("d1", ["u_bob", "u_cy"]);
    expect(db.mentionReaders).toHaveBeenCalledWith(expect.objectContaining({ doc_id: "d1" }), ["u_cy"], "alice");
    expect(sent()).toEqual([
      expect.objectContaining({
        kind: "notify",
        recipient: "u_cy",
        eventType: "MENTIONED_IN_DOC",
        title: 'Alice A mentioned you in "Plan"',
        body: "Owner: @bob and @cy",
        actor: "alice",
      }),
    ]);
  });

  it("notifies no one when nobody is newly mentioned, or the document is in the trash", async () => {
    const quiet = setup([]);
    await dispatchJob(quiet.env, msg(["alice"]), { db: quiet.db, log: silentLog });
    expect(quiet.sent()).toEqual([]);

    const trashed = setup(["u_bob"], { trashed: true });
    await dispatchJob(trashed.env, msg(["alice"]), { db: trashed.db, log: silentLog });
    expect(trashed.db.syncDocMentions).toHaveBeenCalled();
    expect(trashed.sent()).toEqual([]);
  });

  it("names no one when only an agent edited", async () => {
    const { db, env, sent } = setup(["u_bob"]);
    await dispatchJob(env, msg(["agent:claude"]), { db, log: silentLog });
    expect(db.mentionReaders).toHaveBeenCalledWith(expect.anything(), ["u_bob"], null);
    expect(sent()[0]).toMatchObject({ title: 'You were mentioned in "Plan"', body: "Owner: @bob and @cy" });
  });

  it("keeps indexing when the mention step fails", async () => {
    const { db, env } = setup([]);
    vi.mocked(db.syncDocMentions).mockRejectedValueOnce(new Error("db down"));
    await dispatchJob(env, msg(["alice"]), { db, log: silentLog });
    expect(db.clearDocChunks).toHaveBeenCalled();
  });
});
