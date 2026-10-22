import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, closeClients, type Sql } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { addComment } from "./comments.js";
import { createDoc } from "./docs.js";
import { createFolder } from "./folders.js";
import { addWorkspaceMember, provisionWorkspace, removeWorkspaceMember, upsertGroup } from "./workspaces.js";
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
  webhookReaches,
} from "./governance.js";
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
    approverGroup: null,
    approvedBy: [],
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
    it("`attention` for a decider holds only the runs they can decide", async () => {
      await upsertAgentRun(sql, entry({ runId: "r-alice" }));
      await upsertAgentRun(sql, entry({ runId: "r-carol", reviewer: "carol" }));
      const asBob = (admin: boolean) =>
        listAgentRuns(sql, { workspaceId: WS, principals: BOB, filter: "attention", decider: { alias: "bob", admin } });
      // Bob neither reviews these nor owns the document; as an admin he may decide them, but only on a document he can write.
      expect(await asBob(false)).toEqual([]);
      expect(await asBob(true)).toEqual([]);
      await sql`UPDATE docs SET acl_writers = ${["user:alice", "user:bob"]} WHERE doc_id = 'd-shared'`;
      expect((await asBob(true)).map((r) => [r.run_id, r.doc_writable]).sort()).toEqual([
        ["r-alice", true],
        ["r-carol", true],
      ]);
      await sql`UPDATE docs SET acl_writers = ${["user:alice"]} WHERE doc_id = 'd-shared'`;
      // Something applied at once asks only to be looked at, which a reader may do.
      await upsertAgentRun(sql, entry({ runId: "r-auto", reviewer: "bob", pending: 0, applied: 1, autoApplied: true }));
      expect((await asBob(false)).map((r) => [r.run_id, r.doc_writable])).toEqual([["r-auto", false]]);
      await sql`DELETE FROM agent_runs WHERE run_id = 'r-auto'`;
      // Alice owns the document, so she may decide Carol's run too.
      const alice = await listAgentRuns(sql, { workspaceId: WS, principals: ALICE, filter: "attention", decider: { alias: "alice", admin: false } });
      expect(alice.map((r) => [r.run_id, r.doc_owner]).sort()).toEqual([
        ["r-alice", "user:alice"],
        ["r-carol", "user:alice"],
      ]);
      // Every other view still lists them, for reading.
      expect(await listAgentRuns(sql, { workspaceId: WS, principals: BOB, filter: "all", decider: { alias: "bob", admin: false } })).toHaveLength(2);
    });
    it("splits every run into Needs you, Waiting on others and Done", async () => {
      // Alice owns the document: she may decide Carol's run and her own, and look at Bob's; Bob can only read it.
      await upsertAgentRun(sql, entry({ runId: "r-mine", pending: 1 }));
      await upsertAgentRun(sql, entry({ runId: "r-carol", reviewer: "carol", pending: 2 }));
      await upsertAgentRun(sql, entry({ runId: "r-auto", reviewer: "bob", pending: 0, applied: 1, autoApplied: true }));
      await upsertAgentRun(sql, entry({ runId: "r-acked", pending: 0, applied: 1, autoApplied: true, acknowledged: true }));
      await upsertAgentRun(sql, entry({ runId: "r-done", pending: 0, accepted: 1, status: "applied" }));
      const view = async (principals: string[], alias: string, filter: "attention" | "waiting" | "done") =>
        (await listAgentRuns(sql, { workspaceId: WS, principals, filter, decider: { alias, admin: false } })).map((r) => r.run_id).sort();
      expect(await view(ALICE, "alice", "attention")).toEqual(["r-auto", "r-carol", "r-mine"]);
      expect(await view(ALICE, "alice", "waiting")).toEqual([]);
      expect(await view(ALICE, "alice", "done")).toEqual(["r-acked", "r-done"]);
      expect(await view(BOB, "bob", "attention")).toEqual(["r-auto"]);
      expect(await view(BOB, "bob", "waiting")).toEqual(["r-carol", "r-mine"]);
      expect(await view(BOB, "bob", "done")).toEqual(["r-acked", "r-done"]);
      // Together they are every run Bob can read, each once.
      const all = (await listAgentRuns(sql, { workspaceId: WS, principals: BOB, filter: "all" })).map((r) => r.run_id).sort();
      expect([...(await view(BOB, "bob", "attention")), ...(await view(BOB, "bob", "waiting")), ...(await view(BOB, "bob", "done"))].sort()).toEqual(all);
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
    it("narrows to one agent's own runs, and to a time window", async () => {
      const mine = await insertWorkspaceEvent(sql, {
        workspaceId: WS,
        type: "run.decided",
        docId: "d-shared",
        actor: "user:alice",
        actorKind: "human",
        payload: { agent_alias: "agent-1", feedback_id: "fb_1" },
      });
      await insertWorkspaceEvent(sql, { workspaceId: WS, type: "run.decided", docId: "d-shared", actor: "user:alice", actorKind: "human", payload: { agent_alias: "agent-2" } });
      const own = await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0, agentAlias: "agent-1" });
      expect(own.map((e) => e.id)).toEqual([mine!.id]);
      expect(await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0, since: new Date(Date.now() + 60_000) })).toEqual([]);
    });
    it("gives an agent the replies others wrote in threads it started, and none of its own", async () => {
      const added = (num: number, parentNum: number | null, actor: string, at?: Date | string) =>
        insertWorkspaceEvent(sql, {
          workspaceId: WS,
          type: "comment.added",
          docId: "d-shared",
          actor,
          actorKind: actor.startsWith("user:") ? "human" : "agent",
          payload: { num, parent_num: parentNum, excerpt: "…" },
          ...(at === undefined ? {} : { at }),
        });
      const root = await addComment(sql, { docId: "d-shared", author: "agent-1", body: "Built-in or freestanding?" });
      const othersRoot = await addComment(sql, { docId: "d-shared", author: "alice", body: "Check the totals." });
      await added(root.num, null, "agent:agent-1");
      const fromAlice = await added(root.num, root.num, "user:alice");
      await added(root.num, root.num, "agent:agent-1");
      const fromCoauthor = await added(root.num, root.num, "panel:alice");
      // Stamped with the reply's own time, as the node sends it.
      const reply = await addComment(sql, { docId: "d-shared", author: "bob", body: "Freestanding.", parentNum: root.num });
      const fromBob = await added(reply.num, root.num, "user:bob", reply.created_at);
      await added(othersRoot.num, othersRoot.num, "user:bob");
      const decided = await insertWorkspaceEvent(sql, {
        workspaceId: WS,
        type: "run.decided",
        docId: "d-shared",
        actor: "user:alice",
        actorKind: "human",
        payload: { agent_alias: "agent-1" },
      });
      // A reply written in a thread since deleted, whose number the agent's later question took; a
      // late worker writes its event after that question, stamped with when the reply was written.
      const later = await addComment(sql, { docId: "d-shared", author: "agent-1", body: "A later question." });
      await added(later.num + 1, later.num, "user:alice", new Date(new Date(later.created_at).getTime() - 60_000));

      const own = await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0, agentAlias: "agent-1" });
      expect(own.map((e) => e.id)).toEqual([fromAlice!.id, fromCoauthor!.id, fromBob!.id, decided!.id]);
      const replies = await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0, agentAlias: "agent-1", types: ["comment.added"] });
      expect(replies.map((e) => e.id)).toEqual([fromAlice!.id, fromCoauthor!.id, fromBob!.id]);
      expect(await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0, agentAlias: "agent-2" })).toEqual([]);
    });
    it("leaves a person's own replies out by the actor their events carry", async () => {
      const root = await addComment(sql, { docId: "d-shared", author: "alice", body: "Check the totals." });
      const reply = (actor: string) =>
        insertWorkspaceEvent(sql, { workspaceId: WS, type: "comment.added", docId: "d-shared", actor, actorKind: "human", payload: { num: root.num + 1, parent_num: root.num } });
      await reply("user:alice");
      const fromBob = await reply("user:bob");
      const own = await listWorkspaceEvents(sql, { workspaceId: WS, principals: ALICE, after: 0, agentAlias: "alice", selfActor: "user:alice" });
      expect(own.map((e) => e.id)).toEqual([fromBob!.id]);
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
      expect(ids(await matchingWebhooks(sql, WS, "comment.added", ["f-root", "f-leaf"], "d-shared"))).toEqual(["w-all", "w-root"]);
      expect(ids(await matchingWebhooks(sql, WS, "run.decided", ["f-root", "f-leaf"], "d-shared"))).toEqual(["w-all", "w-root", "w-typed"]);
      expect(ids(await matchingWebhooks(sql, WS, "comment.added", [], null))).toEqual(["w-all"]);
    });

    describe("reach only what their creator can read", () => {
      const ids = (rows: Array<{ webhook_id: string }>) => rows.map((r) => r.webhook_id).sort();
      const hook = (webhookId: string, createdBy: string, folderId: string | null = null) =>
        insertWebhook(sql, { webhookId, workspaceId: WS, url: `https://${webhookId}`, secret: "s", events: [], folderId, createdBy });

      beforeEach(async () => {
        await addWorkspaceMember(sql, WS, "bob");
        await hook("w-alice", "alice");
        await hook("w-bob", "bob");
      });

      it("a document shared with nobody but its owner reaches only that owner's hooks, a workspace owner's not", async () => {
        expect(ids(await matchingWebhooks(sql, WS, "doc.created", [], "d-bob"))).toEqual(["w-bob"]);
        expect(await webhookReaches(sql, "w-alice", "d-bob")).toBe(false);
        expect(await webhookReaches(sql, "w-bob", "d-bob")).toBe(true);
      });

      it("a folder hook hears nothing of a document in its folder that its creator cannot read", async () => {
        await createDoc(sql, { docId: "d-leaf-bob", workspaceId: WS, owner: "user:bob", title: "Bob's draft", parentId: "f-leaf", aclPrincipals: ["user:bob"], aclWriters: ["user:bob"] });
        await hook("w-alice-root", "alice", "f-root");
        expect(ids(await matchingWebhooks(sql, WS, "comment.added", ["f-root", "f-leaf"], "d-leaf-bob"))).toEqual(["w-bob"]);
        expect(ids(await matchingWebhooks(sql, WS, "comment.added", ["f-root", "f-leaf"], "d-shared"))).toEqual(["w-alice", "w-alice-root", "w-bob"]);
      });

      it("a group the creator is in counts, as it does for their session", async () => {
        await createDoc(sql, { docId: "d-ops", workspaceId: WS, owner: "user:alice", title: "Ops", parentId: null, aclPrincipals: ["user:alice", "group:ops"], aclWriters: ["user:alice"] });
        expect(ids(await matchingWebhooks(sql, WS, "doc.created", [], "d-ops"))).toEqual(["w-alice"]);
        await upsertGroup(sql, "group:ops", ["user:bob"], WS);
        expect(ids(await matchingWebhooks(sql, WS, "doc.created", [], "d-ops"))).toEqual(["w-alice", "w-bob"]);
      });

      it("a creator who became a guest keeps only what is shared with them directly", async () => {
        await sql`UPDATE workspace_members SET role = 'guest' WHERE workspace_id = ${WS} AND alias = 'bob'`;
        await createDoc(sql, { docId: "d-guest", workspaceId: WS, owner: "user:alice", title: "For Bob", parentId: null, aclPrincipals: ["user:alice", "user:bob"], aclWriters: ["user:alice"] });
        expect(ids(await matchingWebhooks(sql, WS, "doc.created", ["f-root", "f-leaf"], "d-shared"))).toEqual(["w-alice"]);
        expect(ids(await matchingWebhooks(sql, WS, "doc.created", [], "d-guest"))).toEqual(["w-alice", "w-bob"]);
      });

      it("a creator who left the workspace reaches nothing, an event without a document included", async () => {
        await removeWorkspaceMember(sql, WS, "bob");
        expect(ids(await matchingWebhooks(sql, WS, "doc.created", [], "d-bob"))).toEqual([]);
        expect(ids(await matchingWebhooks(sql, WS, "doc.created", ["f-root", "f-leaf"], "d-shared"))).toEqual(["w-alice"]);
        expect(ids(await matchingWebhooks(sql, WS, "doc.created", [], null))).toEqual(["w-alice"]);
        expect(await webhookReaches(sql, "w-bob", "d-shared")).toBe(false);
        expect(await webhookReaches(sql, "w-bob", null)).toBe(false);
      });

      it("a delivery checks again: access lost after the event was matched stops it", async () => {
        expect(await webhookReaches(sql, "w-bob", "d-shared")).toBe(true);
        await sql`UPDATE docs SET acl_principals = ARRAY['user:alice'] WHERE doc_id = 'd-shared'`;
        expect(await webhookReaches(sql, "w-bob", "d-shared")).toBe(false);
        expect(await webhookReaches(sql, "w-alice", "d-shared")).toBe(true);
        expect(await webhookReaches(sql, "w-missing", "d-shared")).toBe(false);
      });
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
