/**
 * `GET /api/agent/session-index` against a real Postgres: what a Claude Code session starts with,
 * team pages first and the person's own notes after them with rows kept for them, how many of each
 * a workspace holds in all, what a confined key reaches, and one audit row per connection per
 * workspace per minute. Needs TEST_DATABASE_URL; skips without it.
 */
import { closeClients, createDoc, createClient, createFolder, createHomeFolder, initSchema, provisionWorkspace, type Sql } from "@stuga/db";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, McpCaller } from "../auth/context.js";
import { fixed, recordingJobs } from "../testing/ctx.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { SESSION_INDEX_LIMIT, SESSION_INDEX_MINE, getSessionIndex } from "./session-index.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_session_index_${process.pid}`;
const WS = "ws-index";
const SIDE = "ws-side";
const ORIGIN = "https://node.test";

let maintenance: LockSql;
let sql: Sql;
let jobs: ReturnType<typeof recordingJobs>;
let env: Record<string, unknown>;

interface Index {
  workspaces: Array<{ workspace_id: string; name: string; my_notes: string | null; counts: { team: number; mine: number } }>;
  docs: Array<{ workspace_id: string; doc_id: string; title: string; type: string; path: string[]; date: string; mine: boolean }>;
  total: number;
  workspaces_left_out?: number;
}

/** `who`'s connection (agent `alias`): an agent with their reach, in every workspace unless `key` confines it. */
function caller(who: string, key?: McpCaller["key"], alias = `agent-${who}`): McpCaller {
  const account = {
    sql,
    surface: "mcp",
    alias,
    displayName: "Scout",
    isAgent: true,
    onBehalfOf: who,
    servedOrigin: ORIGIN,
    arrival: "local",
    env,
  } as unknown as Ctx;
  return { account, workspaces: key ? [key.workspaceId] : null, readOnly: false, ...(key ? { key } : {}) };
}

async function index(c: McpCaller): Promise<Index> {
  const res = await getSessionIndex({ caller: c, req: new Request(`${ORIGIN}/api/agent/session-index`), url: new globalThis.URL(`${ORIGIN}/api/agent/session-index`), match: [] });
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as Index;
}

/** `count` pages, each a minute older than the one before, in `parentId`, readable by `readers`. */
async function pages(prefix: string, count: number, opts: { workspaceId?: string; parentId?: string | null; readers?: string[]; start?: number } = {}) {
  const workspaceId = opts.workspaceId ?? WS;
  const readers = opts.readers ?? ["user:liv", `org:${workspaceId}`];
  for (let i = 0; i < count; i++) {
    const docId = `${prefix}${i}`;
    await createDoc(sql, { docId, workspaceId, owner: "user:liv", title: `${prefix} ${i}`, parentId: opts.parentId ?? null, aclPrincipals: readers, aclWriters: readers });
    await sql`UPDATE docs SET updated_at = ${new Date(Date.UTC(2026, 9, 20) - ((opts.start ?? 0) + i) * 60_000)} WHERE doc_id = ${docId}`;
  }
}

describe.skipIf(!URL)("the session index", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    for (const alias of ["liv", "sam"]) await sql`INSERT INTO users (alias, username, display_name) VALUES (${alias}, ${alias}, ${alias})`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Acme", owner: "liv", defaultDocAccess: "workspace_edit" });
    await provisionWorkspace(sql, { workspaceId: SIDE, name: "Side", owner: "liv", defaultDocAccess: "workspace_edit" });
    await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, 'sam', 'member')`;
    jobs = recordingJobs();
    env = {
      sql,
      publicOrigin: ORIGIN,
      extraOrigins: [],
      jobs,
      embeddingDims: EMBEDDING_DIMS,
      searchLanguages: fixed([]),
      aiSettings: fixed({ chat: { enabled: false }, embed: { enabled: false, searchCutoff: null } }),
      settings: fixed({ nodeLabel: "Studio", nodeName: "Studio", maxBodyBytes: 1_000_000 }),
      nodeId: "node-1",
    };

    await createFolder(sql, { folderId: "f_support", workspaceId: WS, owner: "user:liv", title: "Support", aclPrincipals: ["user:liv", `org:${WS}`] });
    await createFolder(sql, { folderId: "f_private", workspaceId: WS, owner: "user:sam", title: "Sam's drafts", aclPrincipals: ["user:sam"], aclWriters: ["user:sam"] });
    await createHomeFolder(sql, { folderId: "f_notes", workspaceId: WS, alias: "liv", title: "My notes" });
    await createFolder(sql, { folderId: "f_trips", workspaceId: WS, owner: "user:liv", title: "Trips", parentId: "f_notes", aclPrincipals: ["user:liv"], aclWriters: ["user:liv"] });
    // 250 team pages, newer than all of Liv's 50 notes, so a listing by date alone would leave her notes out.
    await pages("t", 240);
    await pages("s", 10, { parentId: "f_support", start: 240 });
    await pages("n", 45, { parentId: "f_notes", readers: ["user:liv"], start: 1000 });
    await pages("trip", 5, { parentId: "f_trips", readers: ["user:liv"], start: 1100 });
    await pages("side", 3, { workspaceId: SIDE });
    // What the index leaves out: a page nobody lets Liv read, one kept out of search, and a row page.
    await pages("sam", 1, { parentId: "f_private", readers: ["user:sam"] });
    await pages("hidden", 1);
    await sql`UPDATE docs SET search_hidden = TRUE WHERE doc_id = 'hidden0'`;
    await pages("row", 1);
    await sql`UPDATE docs SET page_of = 't0', page_row = 'tb.r1' WHERE doc_id = 'row0'`;
  });

  afterAll(async () => {
    await closeClients();
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  it("lists team pages first and keeps rows for the person's own notes, with how many of each there are in all", async () => {
    const got = await index(caller("liv"));
    expect(got.workspaces).toEqual([
      { workspace_id: WS, name: "Acme", my_notes: "f_notes", counts: { team: 250, mine: 50 } },
      { workspace_id: SIDE, name: "Side", my_notes: null, counts: { team: 3, mine: 0 } },
    ]);
    expect(got.total).toBe(303);
    expect(got.docs).toHaveLength(SESSION_INDEX_LIMIT);
    const team = got.docs.filter((d) => !d.mine);
    const mine = got.docs.filter((d) => d.mine);
    expect(mine).toHaveLength(SESSION_INDEX_MINE);
    expect(got.docs.slice(0, team.length).every((d) => !d.mine)).toBe(true);
    // The workspaces take turns, newest first.
    expect(team.slice(0, 4).map((d) => d.doc_id)).toEqual(["t0", "side0", "t1", "side1"]);
    expect(mine[0]).toMatchObject({ doc_id: "n0", path: ["My notes"], mine: true });
    expect(mine.find((d) => d.doc_id.startsWith("trip"))).toBeUndefined();
    const ids = new Set(got.docs.map((d) => d.doc_id));
    for (const left of ["sam0", "hidden0", "row0"]) expect(ids.has(left)).toBe(false);
    expect(JSON.stringify(got)).not.toContain("Sam's drafts");
  });

  it("lists all of a person's notes, a folder of them included, when the team has few pages", async () => {
    const got = await index(caller("sam"));
    // Sam has no My notes, and reads neither Liv's notes nor her other workspace.
    expect(got.workspaces).toEqual([{ workspace_id: WS, name: "Acme", my_notes: null, counts: { team: 251, mine: 0 } }]);
    expect(got.docs.some((d) => d.doc_id === "sam0")).toBe(true);
    expect(got.docs.some((d) => d.doc_id.startsWith("n"))).toBe(false);
  });

  it("reaches only the folders a confined key names", async () => {
    const got = await index(caller("liv", { workspaceId: WS, scope: { folders: ["f_support", "f_trips"], readOnly: false, credentialId: "k1" } }));
    expect(got.workspaces).toEqual([{ workspace_id: WS, name: "Acme", my_notes: null, counts: { team: 10, mine: 5 } }]);
    expect(got.docs.filter((d) => !d.mine).map((d) => d.doc_id).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`).sort());
    expect(got.docs.filter((d) => d.mine).map((d) => d.doc_id)).toEqual(["trip0", "trip1", "trip2", "trip3", "trip4"]);
    expect(got.total).toBe(15);
  });

  it("audits each workspace's read once per connection a minute, by counts alone", async () => {
    jobs.send.mockClear();
    const fresh = () => caller("liv", undefined, "agent-liv-desktop");
    const first = await index(fresh());
    // One row in each workspace's own ledger, with the documents read there.
    const rows = jobs.audits() as Array<{ workspaceId: string }>;
    expect(rows.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
      expect.objectContaining({ action: "mcp.session_index", actor: "agent-liv-desktop", workspaceId: WS, detail: { docs: 300, dedup_window_ms: 60_000 } }),
      expect.objectContaining({ action: "mcp.session_index", actor: "agent-liv-desktop", workspaceId: SIDE, detail: { docs: 3, dedup_window_ms: 60_000 } }),
    ]);
    // A cleared or compacted session asks again at once: the row stands for it.
    jobs.send.mockClear();
    expect((await index(fresh())).docs).toEqual(first.docs);
    expect(jobs.audits()).toEqual([]);
  });
});
