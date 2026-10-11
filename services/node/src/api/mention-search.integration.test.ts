/**
 * Searching for someone to @mention in a document, through the route table
 * against a real Postgres: who can open it (directly, through the workspace,
 * through a group), what a guest finds, and that the bare `@` lists readers.
 * Needs TEST_DATABASE_URL; skips without it.
 */
import { addWorkspaceMember, createDoc, initSchema, upsertGroup } from "@stuga/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../auth/context.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_mention_${process.pid}`;
const WS = "ws-mention";
const ORG = `org:${WS}`;

let maintenance: LockSql;
let sql: LockSql;

function ctxOf(alias: string, role: string, principals: string[]): Ctx {
  return { sql, alias, displayName: alias, isAgent: false, principals, workspaceId: WS, role, env: {} } as unknown as Ctx;
}

const liv = () => ctxOf("liv", "owner", ["user:liv", ORG]);
const gus = () => ctxOf("gus", "guest", ["user:gus"]);

interface Found {
  users: { alias: string; display_name: string; can_open: boolean }[];
  can_share: boolean;
}

async function search(ctx: Ctx, q: string, doc: string): Promise<Found> {
  const res = await routeWorkspaceRequest(ctx, new Request(`https://node.test/api/users/search?q=${encodeURIComponent(q)}&doc=${doc}`));
  expect(res.status).toBe(200);
  return (await res.json()) as Found;
}

describe.skipIf(!URL)("@mention search in a document", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = sessionConnection(withDatabase(URL!, DB));
    await initSchema(sql as never);
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Bakery')`;
    const people: [string, string, string][] = [
      ["liv", "Liv Berg", "owner"],
      ["ben", "Ben Baker", "member"],
      ["bea", "Bea Bell", "member"],
      ["bo", "Bo Brandt", "member"],
      ["gus", "Gus Guest", "guest"],
    ];
    for (const [alias, name, role] of people) {
      await sql`INSERT INTO users (alias, username, display_name) VALUES (${alias}, ${alias}, ${name})`;
      await addWorkspaceMember(sql as never, WS, alias, role as never);
    }
    await upsertGroup(sql as never, "group:ovens", ["user:bo"], WS);
    // Shared with Gus by name and with the ovens group; Ben and Bea are left out.
    await createDoc(sql as never, {
      docId: "d_private",
      workspaceId: WS,
      owner: "user:liv",
      aclPrincipals: ["user:liv", "user:gus", "group:ovens"],
      aclWriters: ["user:liv"],
    });
    // The whole workspace reads it, which a guest's membership does not reach.
    await createDoc(sql as never, { docId: "d_shared", workspaceId: WS, owner: "user:liv", defaultAccess: "workspace_view" });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  it("marks who can open a private document, through a group too, readers first", async () => {
    const found = await search(liv(), "b", "d_private");
    // One letter lists only readers.
    expect(found.users.map((u) => u.alias)).toEqual(["bo"]);

    const typed = await search(liv(), "bo", "d_private");
    expect(typed.users.map((u) => [u.alias, u.can_open])).toEqual([["bo", true]]);

    // "be" matches Liv Berg too, who is asking and so left out.
    const all = await search(liv(), "be", "d_private");
    expect(all.users.map((u) => [u.alias, u.can_open])).toEqual([
      ["bea", false],
      ["ben", false],
    ]);
    expect(all.can_share).toBe(true);
  });

  it("lists the people who can open it on a bare @, never the caller", async () => {
    expect((await search(liv(), "", "d_private")).users.map((u) => u.alias)).toEqual(["bo", "gus"]);
    expect((await search(liv(), "", "d_shared")).users.map((u) => u.alias)).toEqual(["bea", "ben", "bo"]);
  });

  it("lets a guest find the people the document is shared with, and no one else", async () => {
    const found = await search(gus(), "", "d_private");
    expect(found.users.map((u) => u.alias)).toEqual(["bo", "liv"]);
    expect(found.can_share).toBe(false);
    // Ben and Bea are members who cannot open it: a guest is not shown them.
    expect((await search(gus(), "bea", "d_private")).users).toEqual([]);
  });

  it("refuses a document the caller cannot read", async () => {
    const res = await routeWorkspaceRequest(
      ctxOf("ben", "member", ["user:ben", ORG]),
      new Request("https://node.test/api/users/search?q=&doc=d_private"),
    );
    expect(res.status).toBe(404);
  });
});
