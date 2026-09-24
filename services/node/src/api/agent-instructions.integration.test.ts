/**
 * Instructions for agents end to end through the route table against a real
 * Postgres: what a write stores, what a refused write leaves alone, and which
 * levels each reader's answer holds. Needs TEST_DATABASE_URL; skips without it.
 */
import { createDoc, createFolder, getDoc, getFolder, initSchema, updateWorkspaceSettings } from "@stuga/db";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../auth/context.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_instr_${process.pid}`;
const WS = "ws-instr";
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
    principals: [`user:${alias}`, ORG],
    workspaceId: WS,
    role,
    env: {
      jobs: { send: vi.fn(async (m: Record<string, unknown>) => void jobs.push(m)) },
      docs: { get: () => ({ fetch: vi.fn(async () => Response.json({ markdown: "# Deal" })) }) },
    },
    ...over,
  } as unknown as Ctx;
}

const alice = () => ctxOf("alice", "member");
const bob = () => ctxOf("bob", "member");
/** Bob's key, confined to the Deals subfolder. */
const bobsKey = () =>
  ctxOf("agent-1", "member", {
    isAgent: true,
    onBehalfOf: "bob",
    principals: ["agent:agent-1", "user:bob", ORG],
    scope: { folders: ["f_deals"], readOnly: true, keyId: "k1" },
  });

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(ctx, req);
}

describe.skipIf(!URL)("instructions for agents through the REST routes", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = sessionConnection(withDatabase(URL!, DB));
    await initSchema(sql as never);
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Acme')`;
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
    await sql`TRUNCATE docs, folders CASCADE`;
    await updateWorkspaceSettings(sql as never, WS, { agentInstructions: "be brief" });
    // Shared › Private (Alice only) › Deals (shared again), and a deal Bob can edit.
    const everyone = { aclPrincipals: ["user:alice", ORG], aclWriters: ["user:alice", ORG] };
    await createFolder(sql as never, { workspaceId: WS, folderId: "f_shared", owner: "user:alice", title: "Shared", ...everyone });
    await createFolder(sql as never, { workspaceId: WS, folderId: "f_private", owner: "user:alice", title: "Private", parentId: "f_shared" });
    await createFolder(sql as never, { workspaceId: WS, folderId: "f_deals", owner: "user:alice", title: "Deals", parentId: "f_private", ...everyone });
    await createDoc(sql as never, { docId: "d1", workspaceId: WS, owner: "user:alice", title: "Deal", parentId: "f_deals", ...everyone });
  });

  async function setAll(): Promise<void> {
    for (const [id, text] of [
      ["f_shared", "use UK spelling"],
      ["f_private", "never name the client"],
      ["f_deals", "amounts in EUR"],
    ]) {
      expect((await call(alice(), "PATCH", `/api/folders/${id}`, { agent_instructions: text })).status).toBe(200);
    }
    expect((await call(alice(), "PATCH", "/api/docs/d1/state", { agent_instructions: " cite the term sheet\n" })).status).toBe(200);
  }

  it("stores what the owner writes verbatim and records sizes only", async () => {
    await setAll();
    expect((await getDoc(sql as never, "d1"))?.agent_instructions).toBe(" cite the term sheet\n");
    expect((await getFolder(sql as never, "f_private"))?.agent_instructions).toBe("never name the client");
    const audit = jobs.filter((m) => m.kind === "audit");
    expect(audit.map((m) => m.action)).toEqual([
      "folder.agent_instructions",
      "folder.agent_instructions",
      "folder.agent_instructions",
      "doc.agent_instructions",
    ]);
    expect(audit.at(-1)?.detail).toEqual({ chars: 21, from_chars: 0 });
    expect(JSON.stringify(audit)).not.toContain("term sheet");
  });

  it("leaves the row as it was when a request is refused, lock flag included", async () => {
    const res = await call(alice(), "PATCH", "/api/docs/d1/state", { locked: true, agent_instructions: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1) });
    expect(res.status).toBe(400);
    const row = await getDoc(sql as never, "d1");
    expect(row).toMatchObject({ locked: false, agent_instructions: "" });
    expect((await call(bob(), "PATCH", "/api/folders/f_deals", { agent_instructions: "mine now" })).status).toBe(403);
    expect((await getFolder(sql as never, "f_deals"))?.agent_instructions).toBe("");
  });

  it("gives each reader the levels it can read, outermost first", async () => {
    await setAll();
    const forAlice = await (await call(alice(), "GET", "/api/docs/d1/instructions")).json();
    expect(forAlice).toEqual({
      own: " cite the term sheet\n",
      inherited: [
        { kind: "workspace", id: WS, title: "Acme", text: "be brief" },
        { kind: "folder", id: "f_shared", title: "Shared", text: "use UK spelling" },
        { kind: "folder", id: "f_private", title: "Private", text: "never name the client" },
        { kind: "folder", id: "f_deals", title: "Deals", text: "amounts in EUR" },
      ],
      can_edit: true,
    });
    // Bob cannot open Private, so neither its title nor its text reaches him.
    const forBob = (await (await call(bob(), "GET", "/api/folders/f_deals/instructions")).json()) as {
      own: string;
      inherited: Array<{ id: string }>;
      can_edit: boolean;
    };
    expect(forBob.own).toBe("amounts in EUR");
    expect(forBob.inherited.map((l) => l.id)).toEqual([WS, "f_shared"]);
    expect(forBob.can_edit).toBe(false);
  });

  it("hands a scoped read-only key the folders above its scope that its person can read", async () => {
    await setAll();
    const doc = (await (await call(bobsKey(), "GET", "/api/docs/d1")).json()) as { instructions: Array<{ id: string; text: string }> };
    expect(doc.instructions.map((l) => l.id)).toEqual([WS, "f_shared", "f_deals", "d1"]);
    expect(doc.instructions.at(-1)?.text).toBe("cite the term sheet");
    const md = (await (await call(bobsKey(), "GET", "/api/docs/d1/markdown")).json()) as { markdown: string; instructions: unknown[] };
    expect(md.markdown).toBe("# Deal");
    expect(md.instructions).toEqual(doc.instructions);
    // A key outside its scope still finds nothing.
    expect((await call(bobsKey(), "GET", "/api/folders/f_shared/instructions")).status).toBe(404);
  });

  it("says what a folder made in a place would inherit, and refuses a parent the caller cannot open", async () => {
    await setAll();
    const inFolder = (await (await call(alice(), "GET", "/api/folders/instructions?parent_id=f_deals")).json()) as {
      inherited: Array<{ id: string }>;
    };
    // The parent's whole stack, its own level included: that is what the new folder starts from.
    expect(inFolder.inherited.map((l) => l.id)).toEqual([WS, "f_shared", "f_private", "f_deals"]);
    const atRoot = (await (await call(alice(), "GET", "/api/folders/instructions")).json()) as { inherited: Array<{ id: string }> };
    expect(atRoot.inherited.map((l) => l.id)).toEqual([WS]);
    // Bob cannot open Private, so it is left out of what he would inherit.
    const forBob = (await (await call(bob(), "GET", "/api/folders/instructions?parent_id=f_deals")).json()) as {
      inherited: Array<{ id: string }>;
    };
    expect(forBob.inherited.map((l) => l.id)).toEqual([WS, "f_shared", "f_deals"]);
    expect((await call(bob(), "GET", "/api/folders/instructions?parent_id=f_private")).status).toBe(404);
  });

  it("creates a folder with its instructions in the one call, and refuses an over-long one before the row exists", async () => {
    const made = (await (await call(alice(), "POST", "/api/folders", {
      title: "Journal",
      agent_instructions: "  One entry a day.  ",
    })).json()) as { folder_id: string };
    // Stored verbatim on the new row, and the ledger keeps the size alone.
    expect((await getFolder(sql, made.folder_id))?.agent_instructions).toBe("  One entry a day.  ");
    const created = jobs.filter((m) => m.kind === "audit").at(-1) as { action: string; detail: Record<string, unknown> };
    expect(created.action).toBe("folder.create");
    expect(created.detail).toMatchObject({ instruction_chars: 20 });
    expect(JSON.stringify(created.detail)).not.toContain("One entry a day");

    const before = (await (await call(alice(), "GET", "/api/folders")).json()) as { folders: unknown[] };
    const refused = await call(alice(), "POST", "/api/folders", {
      title: "Too much",
      agent_instructions: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1),
    });
    expect(refused.status).toBe(400);
    const after = (await (await call(alice(), "GET", "/api/folders")).json()) as { folders: unknown[] };
    expect(after.folders).toHaveLength(before.folders.length);
  });
});
