import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, closeClients, type Sql } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc } from "./docs.js";
import { createFolder } from "./folders.js";
import { provisionWorkspace } from "./workspaces.js";
import {
  agentRunStats,
  insertWebhook,
  insertWorkspaceEvent,
  latestWorkspaceEventId,
  listAgentRuns,
  listWorkspaceEvents,
  matchingWebhooks,
  purgeAgentRuns,
  recordWebhookDelivery,
  upsertAgentRun,
} from "./governance.js";
import { RUN_IDLE_MS } from "@stuga/protocol/domain/limits";
import type { RunIndexEntry } from "@stuga/protocol/internal/jobs";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("agent governance queries", () => {
  let sql: Sql;
  const WS = "ws-gov";
  const ALICE = ["user:alice", `org:${WS}`];
  const BOB = ["user:bob", `org:${WS}`];

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE agent_runs, workspace_events, webhooks, docs, folders, workspaces CASCADE`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Gov", owner: "alice" });
    await createFolder(sql, { folderId: "f-root", workspaceId: WS, owner: "user:alice", title: "Root", parentId: null, aclPrincipals: ALICE, aclWriters: ALICE });
    await createFolder(sql, { folderId: "f-leaf", workspaceId: WS, owner: "user:alice", title: "Leaf", parentId: "f-root", aclPrincipals: ALICE, aclWriters: ALICE });
    await createDoc(sql, { docId: "d-shared", workspaceId: WS, owner: "user:alice", title: "Shared", parentId: "f-leaf", aclPrincipals: [`org:${WS}`, "user:alice"], aclWriters: ["user:alice"] });
    await createDoc(sql, { docId: "d-bob", workspaceId: WS, owner: "user:bob", title: "Bob's", parentId: null, aclPrincipals: ["user:bob"], aclWriters: ["user:bob"] });
  });

  const entry = (over: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
    runId: "run_1",
    workspaceId: WS,
    docId: "d-shared",
    docKind: "prose",
    docTitle: "old title",
    source: "stdio",
    agent: "bot",
    agentAlias: "agent-1",
    client: null,
    model: null,
    reviewer: "alice",
    status: "open",
    reviewMode: "review",
    autoApplied: false,
    reverted: false,
    acknowledged: false,
    pending: 1,
    accepted: 0,
    rejected: 0,
    conflicts: 0,
    applied: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...over,
  });

  describe("the inbox mirror", () => {
    it("upserts, never regresses to an older state, and reads the live title", async () => {
      await upsertAgentRun(sql, entry());
      await upsertAgentRun(sql, entry({ status: "applied", pending: 0, accepted: 1, updatedAt: 3_000 }));
      await upsertAgentRun(sql, entry({ status: "open", pending: 1, accepted: 0, updatedAt: 2_500 }));
      const rows = await listAgentRuns(sql, { workspaceId: WS, principals: ALICE, filter: "all" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "applied", accepted: 1, pending: 0, doc_title: "Shared" });
    });
    it("is gated by the document's ACL", async () => {
      await upsertAgentRun(sql, entry({ runId: "run_shared" }));
      await upsertAgentRun(sql, entry({ runId: "run_bob", docId: "d-bob" }));
      const alice = await listAgentRuns(sql, { workspaceId: WS, principals: ALICE, filter: "all" });
      expect(alice.map((r) => r.run_id)).toEqual(["run_shared"]);
      const bob = await listAgentRuns(sql, { workspaceId: WS, principals: BOB, filter: "all" });
      expect(bob.map((r) => r.run_id).sort()).toEqual(["run_bob", "run_shared"]);
    });
    it("`attention` is pending work plus unacknowledged auto-applies", async () => {
      await upsertAgentRun(sql, entry({ runId: "r-pending" }));
      await upsertAgentRun(sql, entry({ runId: "r-auto", pending: 0, applied: 1, autoApplied: true, status: "open" }));
      // An auto run stays open after it is acknowledged; the actors never close it on ack.
      await upsertAgentRun(sql, entry({ runId: "r-acked", pending: 0, applied: 1, autoApplied: true, acknowledged: true, status: "open" }));
      await upsertAgentRun(sql, entry({ runId: "r-done", pending: 0, accepted: 1, status: "applied" }));
      const attention = await listAgentRuns(sql, { workspaceId: WS, principals: ALICE, filter: "attention" });
      expect(attention.map((r) => r.run_id).sort()).toEqual(["r-auto", "r-pending"]);
    });
    it("`open` is what still collects changes, by the actors' idle rule; `closed` is the rest", async () => {
      const now = Date.now();
      await upsertAgentRun(sql, entry({ runId: "r-waiting", pending: 1, updatedAt: 2_000 }));
      await upsertAgentRun(sql, entry({ runId: "r-active", pending: 0, applied: 1, autoApplied: true, acknowledged: true, updatedAt: now }));
      await upsertAgentRun(sql, entry({ runId: "r-idle", pending: 0, applied: 1, autoApplied: true, acknowledged: true, updatedAt: now - RUN_IDLE_MS - 60_000 }));
      await upsertAgentRun(sql, entry({ runId: "r-done", pending: 0, accepted: 1, status: "applied" }));
      const open = await listAgentRuns(sql, { workspaceId: WS, principals: ALICE, filter: "open" });
      expect(open.map((r) => r.run_id).sort()).toEqual(["r-active", "r-waiting"]);
      const closed = await listAgentRuns(sql, { workspaceId: WS, principals: ALICE, filter: "closed" });
      expect(closed.map((r) => r.run_id).sort()).toEqual(["r-done", "r-idle"]);
    });
    it("stats aggregate per agent over visible runs only", async () => {
      await upsertAgentRun(sql, entry({ runId: "r1", accepted: 3, rejected: 1, pending: 0, status: "applied" }));
      await upsertAgentRun(sql, entry({ runId: "r2", agentAlias: "agent-2", agent: "other", applied: 2, pending: 0, autoApplied: true, reverted: true, status: "expired" }));
      await upsertAgentRun(sql, entry({ runId: "r3", docId: "d-bob", accepted: 9, pending: 0, status: "applied" }));
      const stats = await agentRunStats(sql, WS, ALICE);
      const one = stats.find((s) => s.agent_alias === "agent-1")!;
      expect(one).toMatchObject({ runs: 1, accepted: 3, rejected: 1 });
      const two = stats.find((s) => s.agent_alias === "agent-2")!;
      expect(two).toMatchObject({ runs: 1, applied: 2, reverted_runs: 1 });
    });
    it("retention sweeps closed runs only", async () => {
      await upsertAgentRun(sql, entry({ runId: "r-open" }));
      await upsertAgentRun(sql, entry({ runId: "r-closed", status: "applied", pending: 0 }));
      await sql`UPDATE agent_runs SET updated_at = now() - interval '400 days'`;
      expect(await purgeAgentRuns(sql, 365)).toBe(1);
      const left = await listAgentRuns(sql, { workspaceId: WS, principals: ALICE, filter: "all" });
      expect(left.map((r) => r.run_id)).toEqual(["r-open"]);
    });
  });

  describe("the event feed", () => {
    it("is cursor-ordered and ACL-gated through the document", async () => {
      const a = await insertWorkspaceEvent(sql, { workspaceId: WS, type: "doc.created", docId: "d-shared", actor: "user:alice", actorKind: "human" });
      await insertWorkspaceEvent(sql, { workspaceId: WS, type: "comment.added", docId: "d-bob", actor: "user:bob", actorKind: "human" });
      const c = await insertWorkspaceEvent(sql, { workspaceId: WS, type: "run.decided", docId: null, actor: "user:alice", actorKind: "human" });
      const alice = await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0 });
      expect(alice.map((e) => e.id)).toEqual([a!.id, c!.id]);
      const later = await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: a!.id });
      expect(later.map((e) => e.id)).toEqual([c!.id]);
      expect(await latestWorkspaceEventId(sql, WS)).toBe(c!.id);
      const typed = await listWorkspaceEvents(sql, { workspaceId: WS, principals: BOB, after: 0, types: ["comment.added"] });
      expect(typed.map((e) => e.doc_id)).toEqual(["d-bob"]);
    });
    it("a scoped key sees only document events inside its folders, and no workspace-level ones", async () => {
      await insertWorkspaceEvent(sql, { workspaceId: WS, type: "doc.updated", docId: "d-shared", actor: "agent:x", actorKind: "agent" });
      await insertWorkspaceEvent(sql, { workspaceId: WS, type: "run.decided", docId: null, actor: "user:alice", actorKind: "human" });
      const inLeaf = await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0, scopeFolderIds: ["f-leaf"] });
      expect(inLeaf.map((e) => e.type)).toEqual(["doc.updated"]);
      const elsewhere = await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0, scopeFolderIds: ["f-root"] });
      expect(elsewhere).toHaveLength(0);
    });
  });

  describe("webhooks", () => {
    it("match on type and on the document's ancestry, active only", async () => {
      await insertWebhook(sql, { webhookId: "w-all", workspaceId: WS, url: "https://a", secret: "s", events: [], folderId: null, createdBy: "alice" });
      await insertWebhook(sql, { webhookId: "w-typed", workspaceId: WS, url: "https://b", secret: "s", events: ["run.decided"], folderId: null, createdBy: "alice" });
      await insertWebhook(sql, { webhookId: "w-root", workspaceId: WS, url: "https://c", secret: "s", events: [], folderId: "f-root", createdBy: "alice" });
      await insertWebhook(sql, { webhookId: "w-off", workspaceId: WS, url: "https://d", secret: "s", events: [], folderId: null, createdBy: "alice" });
      await sql`UPDATE webhooks SET active = FALSE WHERE webhook_id = 'w-off'`;

      const ids = (rows: Array<{ webhook_id: string }>) => rows.map((r) => r.webhook_id).sort();
      expect(ids(await matchingWebhooks(sql, WS, "comment.added", ["f-root", "f-leaf"]))).toEqual(["w-all", "w-root"]);
      expect(ids(await matchingWebhooks(sql, WS, "run.decided", ["f-root", "f-leaf"]))).toEqual(["w-all", "w-root", "w-typed"]);
      expect(ids(await matchingWebhooks(sql, WS, "comment.added", []))).toEqual(["w-all"]);
    });
    it("a delivery record resets or grows the failure streak", async () => {
      await insertWebhook(sql, { webhookId: "w", workspaceId: WS, url: "https://a", secret: "s", events: [], folderId: null, createdBy: "alice" });
      await recordWebhookDelivery(sql, "w", 500, false);
      await recordWebhookDelivery(sql, "w", null, false);
      let [row] = await sql<{ failures: number; last_status: number | null }[]>`SELECT failures, last_status FROM webhooks WHERE webhook_id = 'w'`;
      expect(row).toMatchObject({ failures: 2, last_status: null });
      await recordWebhookDelivery(sql, "w", 204, true);
      [row] = await sql<{ failures: number; last_status: number | null }[]>`SELECT failures, last_status FROM webhooks WHERE webhook_id = 'w'`;
      expect(row).toMatchObject({ failures: 0, last_status: 204 });
    });
  });
});
