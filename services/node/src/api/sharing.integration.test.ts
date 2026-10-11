/**
 * Sharing end to end through the route table against a real Postgres: what a
 * new item in a folder starts with, live share links, the group list and
 * access requests. Needs TEST_DATABASE_URL; skips without it.
 */
import { createFolder, getDoc, getFolder, initSchema, upsertGroup } from "@stuga/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../auth/context.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { redeemShareLink } from "./share-links.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_sharing_${process.pid}`;
const WS = "ws-share";
const ORG = `org:${WS}`;

let maintenance: LockSql;
let sql: LockSql;
let jobs: Array<Record<string, unknown>>;

function ctxOf(alias: string, role: string, over: Record<string, unknown> = {}): Ctx {
  return {
    sql,
    alias,
    displayName: alias,
    isAgent: false,
    principals: role === "guest" ? [`user:${alias}`] : [`user:${alias}`, ORG],
    workspaceId: WS,
    role,
    servedOrigin: "https://node.test",
    env: {
      internalSecret: "s".repeat(43),
      jobs: { send: vi.fn(async (m: Record<string, unknown>) => void jobs.push(m)) },
      docs: { get: () => ({ fetch: vi.fn(async () => Response.json({})) }) },
    },
    ...over,
  } as unknown as Ctx;
}

const alice = () => ctxOf("alice", "member");
const bob = () => ctxOf("bob", "member");

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(ctx, req);
}

describe.skipIf(!URL)("sharing through the REST routes", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = sessionConnection(withDatabase(URL!, DB));
    await initSchema(sql as never);
    // The workspace default: everyone can edit.
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Acme')`;
    for (const alias of ["alice", "bob"]) {
      await sql`INSERT INTO users (alias, username, display_name) VALUES (${alias}, ${alias}, ${alias})`;
      await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, ${alias}, 'member')`;
    }
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    jobs = [];
    await sql`TRUNCATE docs, folders, share_links, groups, notifications CASCADE`;
    // Private: Alice's alone. Read-only: everyone may read, only Alice writes. Open: everyone edits.
    await createFolder(sql as never, { workspaceId: WS, folderId: "f_private", owner: "user:alice", title: "Private" });
    await createFolder(sql as never, {
      workspaceId: WS,
      folderId: "f_read",
      owner: "user:alice",
      title: "Read-only",
      aclPrincipals: ["user:alice", ORG],
      aclWriters: ["user:alice"],
    });
    await createFolder(sql as never, {
      workspaceId: WS,
      folderId: "f_open",
      owner: "user:alice",
      title: "Open",
      aclPrincipals: ["user:alice", ORG],
      aclWriters: ["user:alice", ORG],
    });
  });

  async function created(path: string, body: Record<string, unknown>): Promise<string> {
    const res = await call(alice(), "POST", path, body);
    expect(res.status).toBe(201);
    const row = (await res.json()) as { doc_id?: string; folder_id?: string };
    return (row.doc_id ?? row.folder_id)!;
  }

  describe("a new item never reaches further than its folder", () => {
    it("keeps a document made in a private folder private to its owner", async () => {
      const id = await created("/api/docs", { title: "Pay rates", parent_id: "f_private" });
      const doc = await getDoc(sql as never, id);
      expect(doc?.acl_principals).toEqual(["user:alice"]);
      expect(doc?.own_grants).toEqual({ p: [], w: [], c: [] });
      expect((await call(bob(), "GET", `/api/docs/${id}`)).status).toBe(404);
    });

    it("keeps a sub-folder of a private folder private too", async () => {
      const id = await created("/api/folders", { title: "Managers", parent_id: "f_private" });
      const folder = await getFolder(sql as never, id);
      expect(folder?.acl_principals).toEqual(["user:alice"]);
      expect(folder?.own_grants.p).not.toContain(ORG);
    });

    it("lets everyone read, not edit, inside a folder everyone may only read", async () => {
      const id = await created("/api/docs", { title: "Menu", parent_id: "f_read" });
      const doc = await getDoc(sql as never, id);
      expect(doc?.own_grants).toEqual({ p: [ORG], w: [], c: [] });
      expect(doc?.acl_writers).toEqual(["user:alice"]);
    });

    it("gives the workspace default in an open folder and at the top level", async () => {
      for (const parent of ["f_open", undefined]) {
        const id = await created("/api/docs", { title: "Notes", parent_id: parent });
        expect((await getDoc(sql as never, id))?.own_grants).toEqual({ p: [ORG], w: [ORG], c: [] });
      }
    });
  });

  describe("share links", () => {
    it("lists a live link with its address, and forgets it once revoked", async () => {
      const id = await created("/api/docs", { title: "Recipe" });
      const minted = (await (await call(alice(), "POST", `/api/docs/${id}/share-links`, { role: "commenter" })).json()) as {
        link_url: string;
      };
      expect(minted.link_url).toMatch(/^https:\/\/node\.test\/s\/shl_/);
      const listed = (await (await call(alice(), "GET", `/api/docs/${id}/share-links`)).json()) as {
        links: Array<{ token_hash: string; role: string; link_url: string | null }>;
      };
      expect(listed.links).toHaveLength(1);
      expect(listed.links[0]).toMatchObject({ role: "commenter", link_url: minted.link_url });

      const hash = listed.links[0]!.token_hash;
      expect((await call(alice(), "DELETE", `/api/docs/${id}/share-links/${hash}`)).status).toBe(200);
      const after = (await (await call(alice(), "GET", `/api/docs/${id}/share-links`)).json()) as { links: unknown[] };
      expect(after.links).toEqual([]);
    });

    it("mints distinct links in the same instant", async () => {
      const id = await created("/api/docs", { title: "Recipe" });
      const now = new Date("2026-10-10T08:00:00.000Z");
      vi.useFakeTimers({ now, toFake: ["Date"] });
      try {
        const a = await (await call(alice(), "POST", `/api/docs/${id}/share-links`, {})).json();
        const b = await (await call(alice(), "POST", `/api/docs/${id}/share-links`, {})).json();
        expect(a.link_url).not.toBe(b.link_url);
      } finally {
        vi.useRealTimers();
      }
      const listed = (await (await call(alice(), "GET", `/api/docs/${id}/share-links`)).json()) as {
        links: Array<{ link_url: string | null }>;
      };
      expect(listed.links.every((l) => l.link_url !== null)).toBe(true);
    });

    it("changes a link's level at the same address, so a link already sent keeps working", async () => {
      const id = await created("/api/docs", { title: "Recipe" });
      const minted = (await (await call(alice(), "POST", `/api/docs/${id}/share-links`, { role: "viewer" })).json()) as { link_url: string };
      const hash = ((await (await call(alice(), "GET", `/api/docs/${id}/share-links`)).json()) as { links: Array<{ token_hash: string }> }).links[0]!
        .token_hash;
      jobs = [];
      expect((await call(alice(), "PATCH", `/api/docs/${id}/share-links/${hash}`, { role: "editor" })).status).toBe(200);
      const listed = (await (await call(alice(), "GET", `/api/docs/${id}/share-links`)).json()) as {
        links: Array<{ role: string; link_url: string | null }>;
      };
      expect(listed.links).toEqual([expect.objectContaining({ role: "editor", link_url: minted.link_url })]);
      expect(jobs.filter((j) => j.kind === "audit").map((j) => [j.action, j.detail])).toEqual([["share_link.role", { before: "viewer", after: "editor" }]]);
      expect((await call(bob(), "PATCH", `/api/docs/${id}/share-links/${hash}`, { role: "viewer" })).status).toBe(403);
      expect((await call(alice(), "PATCH", `/api/docs/${id}/share-links/${hash}`, { role: "owner" })).status).toBe(400);
      await call(alice(), "DELETE", `/api/docs/${id}/share-links/${hash}`);
      expect((await call(alice(), "PATCH", `/api/docs/${id}/share-links/${hash}`, { role: "viewer" })).status).toBe(404);
    });

    it("leaves an audit row when a link lets someone in, saying they joined as a guest", async () => {
      await sql`INSERT INTO users (alias, username, display_name) VALUES ('gus', 'gus', 'Gus') ON CONFLICT DO NOTHING`;
      await sql`DELETE FROM workspace_members WHERE alias = 'gus'`;
      const id = await created("/api/docs", { title: "Recipe" });
      const { link_url } = (await (await call(alice(), "POST", `/api/docs/${id}/share-links`, { role: "commenter" })).json()) as { link_url: string };
      jobs = [];
      const gus = ctxOf("gus", "guest", { workspaceId: undefined, role: undefined });
      const req = new Request("https://node.test/api/share-links/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: link_url.split("/s/")[1] }),
      });
      expect((await redeemShareLink({ ctx: gus, req } as never)).status).toBe(200);
      expect(jobs.filter((j) => j.kind === "audit").map((j) => [j.action, j.workspaceId, j.targetId, j.detail])).toEqual([
        ["share_link.redeem", WS, id, { role: "commenter", joined_as_guest: true }],
      ]);
    });
  });

  it("lists the workspace's groups for a member, and refuses a guest", async () => {
    await upsertGroup(sql as never, "group:Kitchen", ["user:bob"], WS);
    await upsertGroup(sql as never, "group:Front", [], WS);
    const res = (await (await call(bob(), "GET", "/api/groups")).json()) as {
      groups: Array<{ group_id: string; members: string[] }>;
    };
    expect(res.groups.map((g) => [g.group_id, g.members])).toEqual([
      ["group:Front", []],
      ["group:Kitchen", ["user:bob"]],
    ]);
    expect((await call(ctxOf("gus", "guest"), "GET", "/api/groups")).status).toBe(403);
  });

  describe("access requests", () => {
    async function requestFromBob(docId: string): Promise<void> {
      expect((await call(bob(), "POST", `/api/docs/${docId}/request-access`)).status).toBe(202);
      // The notify job is what stores the request; this test stores its row as the job would.
      const job = jobs.find((m) => m.eventType === "REQUEST_ACCESS")!;
      await sql`
        INSERT INTO notifications (id, workspace_id, recipient_alias, event_type, resource_id, actor_alias)
        VALUES (${`req-${docId}`}, ${WS}, ${job.recipient as string}, 'REQUEST_ACCESS', ${docId}, ${job.actor as string})`;
    }

    it("lists who is still waiting, drops them once let in, and dismisses on request", async () => {
      const id = await created("/api/docs", { title: "Pay", parent_id: "f_private" });
      await requestFromBob(id);
      const list = async () =>
        ((await (await call(alice(), "GET", `/api/docs/${id}/access-requests`)).json()) as { requests: Array<{ principal: string }> })
          .requests;
      expect(await list()).toEqual([expect.objectContaining({ principal: "user:bob" })]);
      // Bob cannot manage the document, so he cannot read who asked.
      expect((await call(bob(), "GET", `/api/docs/${id}/access-requests`)).status).toBe(404);

      expect((await call(alice(), "PUT", `/api/docs/${id}/acl`, { grants: ["user:bob"], writer_grants: [], inherits: true })).status).toBe(200);
      expect(await list()).toEqual([]);

      expect((await call(alice(), "PUT", `/api/docs/${id}/acl`, { grants: [], writer_grants: [], inherits: true })).status).toBe(200);
      expect(await list()).toHaveLength(1);
      expect((await call(alice(), "DELETE", `/api/docs/${id}/access-requests/${encodeURIComponent("user:bob")}`)).status).toBe(200);
      expect(await list()).toEqual([]);
    });
  });

  it("tells a person once when a save shares a document with them", async () => {
    const id = await created("/api/docs", { title: "Plan" });
    const share = () => call(alice(), "PUT", `/api/docs/${id}/acl`, { grants: ["user:bob"], writer_grants: [], inherits: true });
    expect((await share()).status).toBe(200);
    expect((await share()).status).toBe(200);
    expect(jobs.filter((m) => m.eventType === "DIRECT_DOC_PERMISSIONS").map((m) => m.recipient)).toEqual(["bob"]);
  });

  it("says whether the caller may change sharing", async () => {
    const id = await created("/api/docs", { title: "Plan" });
    const canManage = async (ctx: Ctx) => ((await (await call(ctx, "GET", `/api/docs/${id}/acl`)).json()) as { can_manage: boolean }).can_manage;
    expect(await canManage(alice())).toBe(true);
    expect(await canManage(bob())).toBe(false);
    expect(await canManage(ctxOf("ada", "admin"))).toBe(true);
  });
});
