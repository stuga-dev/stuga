/**
 * The three review levels end to end: folders set them, documents and databases follow, an agent's
 * and the co-author's proposals are stamped with them, and every decision path holds them, through
 * the route table with real document and database actors and a real Postgres. Needs
 * TEST_DATABASE_URL; skips without it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import { closeClients, createClient, createHomeFolder, getDoc, getFolder, initSchema, provisionWorkspace, upsertAgentRun, upsertGroup, type Sql } from "@stuga/db";
import { DOC_STORE_VERSION, DocActor } from "@stuga/doc-actor";
import type { IndexMessage, NotifyApproversMessage, RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, fsBlobStore, type HostedNamespace } from "@stuga/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../auth/context.js";
import { SHARED_NOTES_REASON } from "../authz/review-mode.js";
import { createNodeSettingsStore } from "../config/settings/node.js";
import { tableToolRunner } from "../databases/coauthor.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { handleInternalRequest } from "../internal/routes.js";
import { jobDeps } from "../jobs/deps.js";
import { handleNotifyApprovers } from "../jobs/notify.js";
import { createInternalApi } from "../platform/internal-api.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_levels_${process.pid}`;
const WS = "ws-levels";
const ORG = `org:${WS}`;
/** Liv owns the workspace and asks her agent for changes; Dee is the other admin. Bo, Cy and Ana are members. */
const PEOPLE = [
  ["liv", "owner"],
  ["dee", "admin"],
  ["bo", "member"],
  ["cy", "member"],
  ["ana", "member"],
] as const;
type Person = (typeof PEOPLE)[number][0];

let maintenance: LockSql;
let sql: Sql;
let dir: string;
let namespaces: HostedNamespace[];
let env: Record<string, unknown>;
const jobs: Array<Record<string, unknown>> = [];

function person(alias: Person, groups: string[] = []): Ctx {
  const role = PEOPLE.find(([a]) => a === alias)![1];
  return {
    sql,
    surface: "web",
    alias,
    displayName: alias,
    isAgent: false,
    principals: [`user:${alias}`, ORG, ...groups],
    workspaceId: WS,
    role,
    servedOrigin: "https://node.test",
    env,
  } as unknown as Ctx;
}

/** Liv's agent, with her grants. */
function agent(): Ctx {
  return {
    sql,
    surface: "api-key",
    alias: "agent-1",
    displayName: "Scout",
    isAgent: true,
    onBehalfOf: "liv",
    principals: ["agent:agent-1", "user:liv", ORG],
    workspaceId: WS,
    role: "owner",
    servedOrigin: "https://node.test",
    env,
  } as unknown as Ctx;
}

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(ctx, req);
}

async function ok<T = Record<string, unknown>>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(ctx, method, path, body);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface RunView {
  id: string;
  reviewer: string;
  review_mode: string;
  hunks: Array<{ id: string; new_string: string; status: string }>;
  hunks_withheld?: true;
  you?: { level: string; accept: boolean; reject: boolean; ack: boolean; waits_for?: string };
}

/** A folder `by` makes (Liv unless named), with its writers set as given; the workspace lets everyone read. */
async function folder(title: string, writers: Person[], parentId: string | null = null, by: Person = "liv"): Promise<string> {
  const f = await ok<{ folder_id: string }>(person(by), "POST", "/api/folders", { title, ...(parentId ? { parent_id: parentId } : {}) });
  const w = [`user:${by}`, ...writers.map((p) => `user:${p}`)];
  await sql`UPDATE folders SET acl_principals = ${[`user:${by}`, ORG]}, acl_writers = ${w},
              own_grants = ${sql.json({ p: [`user:${by}`, ORG], w, c: [] })} WHERE folder_id = ${f.folder_id}`;
  return f.folder_id;
}

async function doc(parentId: string | null, owner: Person = "liv"): Promise<string> {
  const d = await ok<{ doc_id: string }>(person(owner), "POST", "/api/docs", {
    title: "Leave policy",
    markdown: "# Leave\n\nTen days a year.\n",
    ...(parentId ? { parent_id: parentId } : {}),
  });
  return d.doc_id;
}

async function propose(docId: string): Promise<{ run: { id: string }; review: string }> {
  return ok(agent(), "POST", `/api/docs/${docId}/propose`, { action: "str_replace", find: "Ten days", replace: "Twelve days" });
}

const runsOf = async (ctx: Ctx, docId: string) => (await ok<{ runs: RunView[] }>(ctx, "GET", `/api/docs/${docId}/runs`)).runs;
const decide = (ctx: Ctx, docId: string, runId: string, decision: "accept" | "reject") =>
  call(ctx, "POST", `/api/docs/${docId}/runs/${runId}/decision`, { decision });
const markdownOf = async (docId: string) => (await ok<{ markdown: string }>(person("liv"), "GET", `/api/docs/${docId}/markdown`)).markdown;

/** The inbox mirror as the job worker would write it, in the order the actors sent it. */
async function mirrorRuns(): Promise<void> {
  for (const m of jobs.filter((j) => j.kind === "run_index")) await upsertAgentRun(sql, m.run as RunIndexEntry);
}

describe.skipIf(!URL)("review levels with real actors", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    for (const [alias] of PEOPLE) await sql`INSERT INTO users (alias, username, display_name) VALUES (${alias}, ${alias}, ${alias})`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Team", owner: "liv", defaultDocAccess: "workspace_view" });
    for (const [alias, role] of PEOPLE.slice(1)) await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, ${alias}, ${role})`;
    await upsertGroup(sql, "group:legal", ["user:bo"], WS);
    await upsertGroup(sql, "group:solo", ["user:liv"], WS);

    dir = mkdtempSync(join(tmpdir(), "stuga-levels-"));
    const snapshots = fsBlobStore(join(dir, "snapshots"));
    const queue = { send: vi.fn(async (m: IndexMessage) => void jobs.push(m as unknown as Record<string, unknown>)) };
    const heartbeat = { request: Heartbeat.PING, response: Heartbeat.PONG };
    const internal = createInternalApi(async () => new Response("not in this test", { status: 503 }));
    const docs = createActorNamespace(DocActor, { snapshots, jobs: queue, ai: () => ({}) as never, internal }, {
      name: "docs",
      heartbeat,
      dir: join(dir, "docs"),
      storeVersion: DOC_STORE_VERSION,
    });
    const databases = createActorNamespace(DatabaseActor, { snapshots, jobs: queue }, {
      name: "databases",
      heartbeat,
      dir: join(dir, "databases"),
      storeVersion: DATABASE_STORE_VERSION,
    });
    namespaces = [docs, databases];
    const settings = await createNodeSettingsStore({ sql, dataDir: dir, publicOrigin: "https://node.test" });
    const media = fsBlobStore(join(dir, "media"));
    env = { sql, publicOrigin: "https://node.test", extraOrigins: [], docs, databases, snapshots, media, jobs: queue, settings, settingsStore: settings, searchLanguages: { current: () => [] } };
  });

  afterAll(async () => {
    for (const ns of namespaces ?? []) await ns.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    await closeClients();
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  beforeEach(() => {
    jobs.length = 0;
  });

  describe("a document in a folder reviewed by a colleague", () => {
    it("refuses its author, a workspace admin, and lets a colleague accept", async () => {
      const f = await folder("Policies", ["bo", "cy", "dee"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const d = await doc(f);
      expect((await ok<{ agent_mode: string; agent_mode_floor: string }>(person("liv"), "GET", `/api/docs/${d}`)).agent_mode).toBe("colleague");
      const proposed = await propose(d);
      expect(proposed.review).toBe("colleague");

      const refused = await decide(person("liv"), d, proposed.run.id, "accept");
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toBe("a colleague approves these changes, not the person who asked the AI");
      const own = (await runsOf(person("liv"), d))[0]!;
      expect(own.you).toEqual({ level: "colleague", accept: false, reject: true, ack: false, waits_for: "colleague" });
      expect(own.hunks.map((h) => h.new_string)).toEqual(["Twelve days"]);

      const colleague = (await runsOf(person("bo"), d))[0]!;
      expect(colleague.you).toEqual({ level: "colleague", accept: true, reject: true, ack: true });
      expect((await decide(person("bo"), d, proposed.run.id, "accept")).status).toBe(200);
      expect(await markdownOf(d)).toContain("Twelve days a year.");

      // The mirror names who approved, never the one who asked.
      await mirrorRuns();
      const [row] = await sql<{ review_mode: string; approved_by: string[]; reviewer: string }[]>`
        SELECT review_mode, approved_by, reviewer FROM agent_runs WHERE run_id = ${proposed.run.id}`;
      expect(row).toEqual({ review_mode: "colleague", approved_by: ["bo"], reviewer: "liv" });
    });

    it("tells whoever may approve, and the author that it waits for a colleague", async () => {
      const f = await folder("Contracts", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const d = await doc(f);
      await propose(d);
      const asked = jobs.find((j) => j.kind === "notify" && j.eventType === "AGENT_EDITS_PROPOSED");
      expect(asked).toMatchObject({ recipient: "liv", params: { waits: "colleague", count: 1 } });
      const fanout = jobs.find((j) => j.kind === "notify_approvers") as NotifyApproversMessage;
      expect(fanout).toMatchObject({ reviewer: "liv", docId: d, count: 1 });

      // The job works out who may approve now: everyone else who can write it, Dee (an admin who cannot) left out.
      await handleNotifyApprovers(env as never, jobDeps(env as never, {}), fanout);
      const rows = await sql<{ recipient_alias: string; payload: Record<string, unknown> }[]>`
        SELECT recipient_alias, payload FROM notifications WHERE event_type = 'APPROVAL_WAITING' AND resource_id = ${d} ORDER BY recipient_alias`;
      expect(rows.map((r) => r.recipient_alias)).toEqual(["bo", "cy"]);
      expect(rows[0]!.payload).toMatchObject({ author: "liv", count: 1, doc: "Leave" });
    });

    it("keeps a change waiting when the page moves out of the folder", async () => {
      const f = await folder("Handbook", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const elsewhere = await folder("Elsewhere", ["bo"]);
      const d = await doc(f);
      const { run } = await propose(d);
      await ok(person("liv"), "PATCH", `/api/docs/${d}`, { parent_id: elsewhere });
      expect((await ok<{ agent_mode: string }>(person("liv"), "GET", `/api/docs/${d}`)).agent_mode).toBe("review");
      expect((await decide(person("liv"), d, run.id, "accept")).status).toBe(403);
      expect((await decide(person("bo"), d, run.id, "accept")).status).toBe(200);
    });

    it("keeps a change waiting when the folder is loosened after it was proposed, and tells the other admins", async () => {
      const f = await folder("Finance", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const d = await doc(f);
      const { run } = await propose(d);
      jobs.length = 0;
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "auto" });
      const lowered = jobs.filter((j) => j.kind === "notify" && j.eventType === "REVIEW_LEVEL_LOWERED");
      expect(lowered.map((j) => j.recipient)).toEqual(["dee"]);
      expect(lowered[0]).toMatchObject({ folder: true, params: { kind: "folder", level: "auto", floor: null } });
      expect(jobs).toContainEqual(expect.objectContaining({ kind: "audit", action: "folder.agent_mode" }));

      expect((await decide(person("liv"), d, run.id, "accept")).status).toBe(403);
      // The asker may still take it back.
      expect((await decide(person("liv"), d, run.id, "reject")).status).toBe(200);
    });

    it("lets nobody without write access decide, and shows a reader without rights no text", async () => {
      const f = await folder("Board", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const d = await doc(f);
      const { run } = await propose(d);
      // Ana can read the page and nothing more.
      const refused = await decide(person("ana"), d, run.id, "accept");
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toBe("view-only access");
      const seen = await runsOf(person("ana"), d);
      expect(seen[0]).toMatchObject({ id: run.id, hunks: [], hunks_withheld: true, you: { accept: false, reject: false } });
      const full = await (await call(person("ana"), "GET", `/api/docs/${d}/runs/${run.id}?full=1`)).text();
      expect(full).not.toContain("Twelve days");
      expect(full).not.toContain("Ten days");
      // Its approver reads it in full.
      const forBo = await (await call(person("bo"), "GET", `/api/docs/${d}/runs/${run.id}?full=1`)).text();
      expect(forBo).toContain("Twelve days");
      expect(forBo).toContain("baseline_markdown");
    });

    it("holds an approver group, and lets an owner or admin stand in only when nobody else can", async () => {
      const legal = await folder("Legal", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${legal}`, { agent_mode: "colleague", approver_group: "legal" });
      expect((await getFolder(sql, legal))?.approver_group).toBe("group:legal");
      const d = await doc(legal);
      const { run } = await propose(d);
      const outside = await decide(person("cy"), d, run.id, "accept");
      expect(outside.status).toBe(403);
      expect(((await outside.json()) as { error: string }).error).toBe("only someone in this document's approver group approves these changes");
      expect((await decide(person("bo", ["group:legal"]), d, run.id, "accept")).status).toBe(200);

      // A group of the author alone: Dee, an admin who can write it, stands in; Bo cannot.
      const solo = await folder("Solo", ["bo", "dee"]);
      await ok(person("liv"), "PATCH", `/api/folders/${solo}`, { agent_mode: "colleague", approver_group: "group:solo" });
      const d2 = await doc(solo);
      const second = await propose(d2);
      expect((await runsOf(person("liv", ["group:solo"]), d2))[0]!.you).toMatchObject({ accept: false, waits_for: "colleague" });
      expect((await decide(person("bo"), d2, second.run.id, "accept")).status).toBe(403);
      expect((await decide(person("dee"), d2, second.run.id, "accept")).status).toBe(200);

      // Nobody but the author can write it: it waits, and says so.
      const mine = await folder("Mine", []);
      await ok(person("liv"), "PATCH", `/api/folders/${mine}`, { agent_mode: "colleague" });
      const d3 = await doc(mine);
      const third = await propose(d3);
      expect((await runsOf(person("liv"), d3))[0]!.you).toEqual({ level: "colleague", accept: false, reject: true, ack: false, waits_for: "nobody" });
      expect((await decide(person("dee"), d3, third.run.id, "accept")).status).toBe(403);
    });

    it("puts the run in a colleague's inbox and out of its author's", async () => {
      const f = await folder("Inbox", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const d = await doc(f);
      const { run } = await propose(d);
      await mirrorRuns();
      const inbox = async (ctx: Ctx) =>
        (await ok<{ runs: Array<{ run_id: string; can_decide: boolean; you: { accept: boolean } }> }>(ctx, "GET", "/api/runs?filter=attention")).runs.filter(
          (r) => r.run_id === run.id,
        );
      expect(await inbox(person("bo"))).toEqual([expect.objectContaining({ can_decide: true, you: expect.objectContaining({ accept: true }) })]);
      expect(await inbox(person("liv"))).toEqual([]);
      const all = (await ok<{ runs: Array<{ run_id: string; you: { waits_for?: string } }> }>(person("liv"), "GET", "/api/runs?filter=all")).runs;
      expect(all.find((r) => r.run_id === run.id)?.you.waits_for).toBe("colleague");
    });

    it("refuses a mirror row that names the person who asked as an approver", async () => {
      const entry: RunIndexEntry = {
        runId: "run_self",
        workspaceId: WS,
        docId: "d-none",
        docKind: "prose",
        docTitle: "x",
        source: "stdio",
        agent: "Scout",
        agentAlias: "agent-1",
        client: null,
        model: null,
        reviewer: "liv",
        status: "open",
        reviewMode: "colleague",
        approverGroup: null,
        approvedBy: ["liv"],
        autoApplied: false,
        reverted: false,
        acknowledged: false,
        pending: 0,
        accepted: 1,
        rejected: 0,
        conflicts: 0,
        applied: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      await expect(upsertAgentRun(sql, entry)).rejects.toThrow(/agent_runs_approved_by_check/);
    });
  });

  describe("the co-author", () => {
    it("is told the level, and its runs wait for a colleague like an agent's", async () => {
      const f = await folder("Notes", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague", approver_group: "legal" });
      const d = await doc(f);
      const asked = await handleInternalRequest(
        new Request("http://node/internal/review-mode", {
          method: "POST",
          body: JSON.stringify({ workspaceId: WS, docId: d, principals: ["user:liv", ORG] }),
        }),
        env as never,
      );
      expect(await asked.json()).toEqual({ mode: "colleague", approver_group: "group:legal", title: "Leave" });

      // Its turn proposes into the open document's ledger under that level, as the actor does it.
      const proposed = await (
        await (env.docs as HostedNamespace).get(d).fetch(`http://actor/runs/propose?docId=${d}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "str_replace",
            find: "Ten days",
            replace: "Fifteen days",
            source: "panel",
            review: "colleague",
            approver_group: "group:legal",
            agent: "AI co-author",
            agent_alias: "panel:liv",
            reviewer: "liv",
            workspace_id: WS,
            doc_title: "Leave policy",
          }),
        })
      ).json() as { run: { id: string; approver_group: string } };
      expect(proposed.run.approver_group).toBe("group:legal");
      expect((await decide(person("liv"), d, proposed.run.id, "accept")).status).toBe(403);
      expect((await decide(person("bo", ["group:legal"]), d, proposed.run.id, "accept")).status).toBe(200);
    });

    it("stages a table's changes under the database's level", async () => {
      const f = await folder("Tables", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const db = await ok<{ doc_id: string }>(person("liv"), "POST", "/api/docs", {
        doc_type: "database",
        title: "Holidays",
        parent_id: f,
        columns: [{ name: "Name", type: "text" }],
      });
      const row = (await getDoc(sql, db.doc_id))!;
      const table = (await ok<{ tables: Array<{ table_id: string }> }>(person("liv"), "GET", `/api/databases/${db.doc_id}/schema`)).tables[0]!.table_id;
      const { runner, runId } = tableToolRunner(person("liv"), row, {} as never, null);
      const staged = await runner.stageOp({ kind: "rows.insert", table, rows: [{ Name: "Midsummer" }] });
      expect(staged).toMatchObject({ staged: true, applied: false });
      const decided = await call(person("liv"), "POST", `/api/databases/${db.doc_id}/runs/${runId()}/decision`, { decision: "accept" });
      expect(decided.status).toBe(403);
      expect((await call(person("bo"), "POST", `/api/databases/${db.doc_id}/runs/${runId()}/decision`, { decision: "accept" })).status).toBe(200);
    });
  });

  describe("a database reviewed by a colleague", () => {
    it("refuses its author, lets a colleague accept, and shows a reader the ops without their values", async () => {
      const f = await folder("Data", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const db = await ok<{ doc_id: string }>(person("liv"), "POST", "/api/docs", {
        doc_type: "database",
        title: "Salaries",
        parent_id: f,
        columns: [{ name: "Name", type: "text" }],
      });
      const table = (await ok<{ tables: Array<{ table_id: string }> }>(person("liv"), "GET", `/api/databases/${db.doc_id}/schema`)).tables[0]!.table_id;
      const proposed = await ok<{ mode: string; run: { id: string } }>(agent(), "POST", `/api/databases/${db.doc_id}/tables/${table}/rows`, {
        rows: [{ Name: "Secret raise" }],
      });
      expect(proposed.mode).toBe("proposed");
      const path = `/api/databases/${db.doc_id}/runs/${proposed.run.id}`;
      expect((await call(person("liv"), "POST", `${path}/decision`, { decision: "accept" })).status).toBe(403);

      const forAna = await (await call(person("ana"), "GET", `/api/databases/${db.doc_id}/runs`)).text();
      expect(forAna).toContain('"ops_withheld":true');
      expect(forAna).not.toContain("Secret raise");
      // Nor the op's summary or detail: an op that has not landed is the reviewer's, its approvers' and the managers' to read.
      expect(forAna).toContain('"ops":[]');
      expect(await (await call(person("bo"), "GET", path)).text()).toContain("Secret raise");

      expect((await call(person("bo"), "POST", `${path}/decision`, { decision: "accept" })).status).toBe(200);
      await mirrorRuns();
      const [mirror] = await sql<{ approved_by: string[] }[]>`SELECT approved_by FROM agent_runs WHERE run_id = ${proposed.run.id}`;
      expect(mirror?.approved_by).toEqual(["bo"]);
    });
  });

  describe("who sets a level", () => {
    it("lets a document's owner go stricter, and only the folder's owner or an admin below the folder's level", async () => {
      const f = await folder("Shared", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "review" });
      const d = await doc(f, "bo");
      const tighter = await ok<{ agent_mode: string; agent_mode_floor: string }>(person("bo"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "colleague" });
      expect(tighter).toMatchObject({ agent_mode: "colleague", agent_mode_floor: "review" });
      const looser = await call(person("bo"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "auto" });
      expect(looser.status).toBe(403);
      expect(((await looser.json()) as { error: string }).error).toBe("only the folder's owner or a workspace admin can make this looser than its folder");
      expect((await call(agent(), "PATCH", `/api/docs/${d}/state`, { agent_mode: "colleague" })).status).toBe(403);

      // Liv owns the folder, not the page: she may set it below the folder's level, and the other admins hear of it.
      jobs.length = 0;
      expect((await ok(person("liv"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "auto" })).agent_mode).toBe("auto");
      expect(jobs.filter((j) => j.eventType === "REVIEW_LEVEL_LOWERED").map((j) => j.recipient)).toEqual(["dee"]);
      expect(jobs).toContainEqual(
        expect.objectContaining({ kind: "audit", action: "doc.agent_mode", detail: expect.objectContaining({ mode: "auto", below_floor: true, floor: "review" }) }),
      );
      // Choosing what the folder gives stores nothing of its own: the page follows the folder again.
      await ok(person("bo"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "review" });
      expect((await getDoc(sql, d))?.agent_mode).toBeNull();
    });

    it("needs the owner of every folder a level goes below, not only the nearest, and guards an inherited approver group", async () => {
      const outer = await folder("Outer", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${outer}`, { agent_mode: "review", approver_group: "legal" });
      // Bo owns a stricter folder inside Liv's, and a page in it.
      const inner = (await ok<{ folder_id: string }>(person("bo"), "POST", "/api/folders", { title: "Inner", parent_id: outer })).folder_id;
      await ok(person("bo"), "PATCH", `/api/folders/${inner}`, { agent_mode: "colleague" });
      const d = await doc(inner, "bo");
      // Below his own folder's level, Bo's call; below Liv's too, not.
      expect((await call(person("bo"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "auto" })).status).toBe(403);
      expect((await ok<{ agent_mode: string }>(person("bo"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "review" })).agent_mode).toBe("review");
      expect((await ok<{ agent_mode: string }>(person("dee"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "auto" })).agent_mode).toBe("auto");

      // Liv's folder names who approves beneath it: Bo cannot name another in his, and may follow hers.
      const swapped = await call(person("bo"), "PATCH", `/api/folders/${inner}`, { approver_group: "solo" });
      expect(swapped.status).toBe(403);
      expect(((await swapped.json()) as { error: string }).error).toBe(
        "only the owner of the folder that names the approver group, or a workspace admin, can name another beneath it",
      );
      expect((await call(person("bo"), "PATCH", `/api/folders/${inner}`, { approver_group: null })).status).toBe(200);
      expect((await ok<{ approver_group: string }>(person("liv"), "PATCH", `/api/folders/${inner}`, { approver_group: "solo" })).approver_group).toBe(
        "group:solo",
      );
    });

    it("sets an exception back when the page moves, and a subfolder's when the folder moves", async () => {
      const open = await folder("Open", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${open}`, { agent_mode: "auto" });
      const strict = await folder("Strict", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${strict}`, { agent_mode: "colleague" });
      const d = await doc(open);
      await ok(person("liv"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "review" });
      // Review is stricter than its folder's auto, and looser than Strict's colleague: moved there, it follows Strict.
      jobs.length = 0;
      const moved = await ok<{ agent_mode: string }>(person("liv"), "PATCH", `/api/docs/${d}`, { parent_id: strict });
      expect(moved.agent_mode).toBe("colleague");
      expect((await getDoc(sql, d))?.agent_mode).toBeNull();
      expect(jobs).toContainEqual(expect.objectContaining({ kind: "audit", action: "doc.agent_mode", detail: expect.objectContaining({ reason: "moved" }) }));

      const sub = await folder("Drafts", ["bo"], open);
      await sql`UPDATE folders SET agent_mode = 'auto' WHERE folder_id = ${sub}`;
      const inner = await doc(sub);
      await ok(person("liv"), "PATCH", `/api/folders/${sub}`, { parent_id: strict });
      expect((await getFolder(sql, sub))?.agent_mode).toBeNull();
      expect((await ok<{ agent_mode: string }>(person("liv"), "GET", `/api/docs/${inner}`)).agent_mode).toBe("colleague");
    });
  });
  describe("a move", () => {
    const MOVE_REFUSED = "only its owner, its folder's owner or a workspace admin can move this somewhere AI edits are reviewed less strictly";
    const refusal = async (res: Response) => ({ status: res.status, error: ((await res.json()) as { error?: string }).error });

    it("refuses a writer who would take a page out from under a colleague folder: to a folder of their own, or to the top level", async () => {
      const legal = await folder("Legal M", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${legal}`, { agent_mode: "colleague" });
      const page = await doc(legal);
      const own = await doc(legal, "bo");
      // Bo makes a folder of his own and lets AI edits apply directly in it.
      const mine = await folder("Bo scratch", [], null, "bo");
      await ok(person("bo"), "PATCH", `/api/folders/${mine}`, { agent_mode: "auto" });
      for (const [d, dest] of [
        [page, mine],
        [own, null],
        [own, mine],
      ] as const) {
        expect(await refusal(await call(person("bo"), "PATCH", `/api/docs/${d}`, { parent_id: dest }))).toEqual({ status: 403, error: MOVE_REFUSED });
        expect((await getDoc(sql, d))?.parent_id).toBe(legal);
      }
      // Nor into a folder of his own just as strict, which he alone could loosen once it is there.
      const strict = await folder("Bo strict", [], null, "bo");
      await ok(person("bo"), "PATCH", `/api/folders/${strict}`, { agent_mode: "colleague" });
      expect(await refusal(await call(person("bo"), "PATCH", `/api/docs/${page}`, { parent_id: strict }))).toEqual({ status: 403, error: MOVE_REFUSED });
      // An agent's edit to it still waits for a colleague.
      expect((await propose(page)).review).toBe("colleague");
    });

    it("refuses a folder's owner who would take it out from under a stricter folder, a level set in the same request included", async () => {
      const legal = await folder("Legal O", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${legal}`, { agent_mode: "colleague" });
      const sub = (await ok<{ folder_id: string }>(person("bo"), "POST", "/api/folders", { title: "Bo sub", parent_id: legal })).folder_id;
      const page = await doc(sub);
      expect(await refusal(await call(person("bo"), "PATCH", `/api/folders/${sub}`, { parent_id: null }))).toEqual({ status: 403, error: MOVE_REFUSED });
      expect((await call(person("bo"), "PATCH", `/api/folders/${sub}`, { parent_id: null, agent_mode: "auto" })).status).toBe(403);
      expect((await getFolder(sql, sub))?.parent_id).toBe(legal);
      expect((await ok<{ agent_mode: string }>(person("liv"), "GET", `/api/docs/${page}`)).agent_mode).toBe("colleague");
    });

    it("lets a writer move a page where it stays as strict, and the folder's owner or an admin anywhere, in the ledger and told", async () => {
      const legal = await folder("Legal N", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${legal}`, { agent_mode: "colleague" });
      // Cy's folder, just as strict: Bo cannot loosen it.
      const contracts = await folder("Contracts N", ["bo"], null, "cy");
      await ok(person("cy"), "PATCH", `/api/folders/${contracts}`, { agent_mode: "colleague" });
      const page = await doc(legal);
      expect((await call(person("bo"), "PATCH", `/api/docs/${page}`, { parent_id: contracts })).status).toBe(200);

      // Liv, an admin, takes it to the top level: looser, so the ledger has it and Dee hears of it.
      jobs.length = 0;
      expect((await ok<{ agent_mode: string }>(person("liv"), "PATCH", `/api/docs/${page}`, { parent_id: null })).agent_mode).toBe("review");
      expect(jobs).toContainEqual(
        expect.objectContaining({
          kind: "audit",
          action: "doc.agent_mode",
          detail: expect.objectContaining({ mode: "review", from: "colleague", reason: "moved", floor: "colleague" }),
        }),
      );
      expect(jobs.filter((j) => j.eventType === "REVIEW_LEVEL_LOWERED")).toEqual([
        expect.objectContaining({ recipient: "dee", params: expect.objectContaining({ moved: true, level: "review", floor: "colleague" }) }),
      ]);

      // Cy, who owns the folder but is no admin, may take Bo's page out of it.
      const second = await doc(contracts, "bo");
      jobs.length = 0;
      expect((await call(person("cy"), "PATCH", `/api/docs/${second}`, { parent_id: null })).status).toBe(200);
      expect(jobs.filter((j) => j.eventType === "REVIEW_LEVEL_LOWERED").map((j) => j.recipient).sort()).toEqual(["dee", "liv"]);
    });

    it("keeps what a deleted folder held under the folders above it, so deleting it releases nothing", async () => {
      const legal = await folder("Legal D", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${legal}`, { agent_mode: "colleague" });
      const sub = (await ok<{ folder_id: string }>(person("bo"), "POST", "/api/folders", { title: "Bo temp", parent_id: legal })).folder_id;
      const page = await doc(sub);
      expect((await call(person("bo"), "DELETE", `/api/folders/${sub}`)).status).toBe(200);
      expect((await call(person("bo"), "PATCH", `/api/docs/${page}`, { trashed: false })).status).toBe(200);
      expect(await ok(person("bo"), "GET", `/api/docs/${page}`)).toMatchObject({ parent_id: legal, agent_mode: "colleague" });
    });

    it("counts a row page without its database's level, from which it can be parted", async () => {
      const legal = await folder("Legal R", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${legal}`, { agent_mode: "colleague" });
      const db = await ok<{ doc_id: string }>(person("liv"), "POST", "/api/docs", { doc_type: "database", title: "Pay", parent_id: legal, columns: [{ name: "Name", type: "text" }] });
      const table = (await ok<{ tables: Array<{ table_id: string }> }>(person("liv"), "GET", `/api/databases/${db.doc_id}/schema`)).tables[0]!.table_id;
      const inserted = await ok<{ row_ids: string[] }>(person("liv"), "POST", `/api/databases/${db.doc_id}/tables/${table}/rows`, { rows: [{ Name: "Ada" }] });
      const page = (await ok<{ doc_id: string }>(person("liv"), "POST", `/api/databases/${db.doc_id}/tables/${table}/rows/${inserted.row_ids[0]}/page`, {})).doc_id;
      const mine = await folder("Bo loose", [], null, "bo");
      await ok(person("bo"), "PATCH", `/api/folders/${mine}`, { agent_mode: "auto" });
      expect(await refusal(await call(person("bo"), "PATCH", `/api/docs/${page}`, { parent_id: mine }))).toEqual({ status: 403, error: MOVE_REFUSED });
    });

    it("keeps a level an item's owner chose: moved by someone else, only its owner or an admin loosens it", async () => {
      // Liv's page sets `colleague` itself, at the top level.
      const page = await doc(null);
      await ok(person("liv"), "PATCH", `/api/docs/${page}/state`, { agent_mode: "colleague" });
      await sql`UPDATE docs SET acl_writers = acl_writers || ARRAY['user:bo'] WHERE doc_id = ${page}`;
      const mine = await folder("Bo plain", [], null, "bo");
      expect((await call(person("bo"), "PATCH", `/api/docs/${page}`, { parent_id: mine })).status).toBe(200);
      expect((await call(person("bo"), "PATCH", `/api/docs/${page}/state`, { agent_mode: "auto" })).status).toBe(403);
      // In a stricter folder of his own inside Cy's, he could set it back to what Cy's folder gives: refused.
      const cys = await folder("Cy review", ["bo"], null, "cy");
      await ok(person("cy"), "PATCH", `/api/folders/${cys}`, { agent_mode: "review" });
      const theirs = await doc(cys, "cy");
      await ok(person("cy"), "PATCH", `/api/docs/${theirs}/state`, { agent_mode: "colleague" });
      const strict = (await ok<{ folder_id: string }>(person("bo"), "POST", "/api/folders", { title: "Bo strict sub", parent_id: cys })).folder_id;
      await ok(person("bo"), "PATCH", `/api/folders/${strict}`, { agent_mode: "colleague" });
      expect(await refusal(await call(person("bo"), "PATCH", `/api/docs/${theirs}`, { parent_id: strict }))).toEqual({ status: 403, error: MOVE_REFUSED });
    });

    it("keeps an approver group someone else names: a page at colleague lands only where the same group approves", async () => {
      const legal = await folder("Legal G", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${legal}`, { agent_mode: "colleague", approver_group: "legal" });
      const contracts = await folder("Contracts G", ["bo"], null, "cy");
      await ok(person("cy"), "PATCH", `/api/folders/${contracts}`, { agent_mode: "colleague" });
      const page = await doc(legal);
      expect(await refusal(await call(person("bo"), "PATCH", `/api/docs/${page}`, { parent_id: contracts }))).toEqual({
        status: 403,
        error: "a folder above names the approver group; only its owner or a workspace admin can move this where another group approves",
      });
      // Within the folder that names it, it moves as it likes.
      const inner = await folder("Legal G inner", ["bo"], legal);
      expect((await call(person("bo"), "PATCH", `/api/docs/${page}`, { parent_id: inner })).status).toBe(200);
    });

    it("keeps no guard on the default level: a writer takes their page out of a folder that sets none", async () => {
      const plain = await folder("Plain", ["bo"]);
      const page = await doc(plain, "bo");
      expect((await call(person("bo"), "PATCH", `/api/docs/${page}`, { parent_id: null })).status).toBe(200);
    });
  });

  describe("a database's row pages", () => {
    it("are reviewed at least as strictly as their database, for agents, the co-author, the inbox and whoever sets them", async () => {
      const f = await folder("Tables R", ["bo"]);
      const db = await ok<{ doc_id: string }>(person("liv"), "POST", "/api/docs", {
        doc_type: "database",
        title: "Salaries",
        parent_id: f,
        columns: [{ name: "Name", type: "text" }],
      });
      await ok(person("liv"), "PATCH", `/api/docs/${db.doc_id}/state`, { agent_mode: "colleague" });
      const table = (await ok<{ tables: Array<{ table_id: string }> }>(person("liv"), "GET", `/api/databases/${db.doc_id}/schema`)).tables[0]!.table_id;
      const inserted = await ok<{ row_ids: string[] }>(person("liv"), "POST", `/api/databases/${db.doc_id}/tables/${table}/rows`, { rows: [{ Name: "Ada" }] });
      const page = (await ok<{ doc_id: string }>(person("liv"), "POST", `/api/databases/${db.doc_id}/tables/${table}/rows/${inserted.row_ids[0]}/page`, {})).doc_id;
      expect(await ok(person("liv"), "GET", `/api/docs/${page}`)).toMatchObject({
        agent_mode: "colleague",
        agent_mode_floor: "colleague",
        // What the level dialog says and holds it to: its folder's level, and its database's, which nobody goes below.
        agent_mode_floors: { folder: "review", database: "colleague", notes: null },
      });

      const proposed = await ok<{ run: { id: string }; review: string }>(agent(), "POST", `/api/docs/${page}/propose`, { action: "append", text: "Raise to 500." });
      expect(proposed.review).toBe("colleague");
      expect((await decide(person("liv"), page, proposed.run.id, "accept")).status).toBe(403);
      const asked = await handleInternalRequest(
        new Request("http://node/internal/review-mode", { method: "POST", body: JSON.stringify({ workspaceId: WS, docId: page, principals: ["user:liv", ORG] }) }),
        env as never,
      );
      expect(await asked.json()).toMatchObject({ mode: "colleague" });
      expect((await call(person("liv"), "PATCH", `/api/docs/${page}/state`, { agent_mode: "review" })).status).toBe(400);

      await mirrorRuns();
      const inbox = (await ok<{ runs: Array<{ run_id: string; can_decide: boolean; you: { level: string } }> }>(person("bo"), "GET", "/api/runs?filter=attention")).runs;
      expect(inbox.find((r) => r.run_id === proposed.run.id)).toMatchObject({ can_decide: true, you: { level: "colleague" } });
      expect((await decide(person("bo"), page, proposed.run.id, "accept")).status).toBe(200);
    });
  });

  describe("after the fact", () => {
    it("leaves marking reviewed what applied at once to whoever asked, out of colleagues' queues, after the folder is raised", async () => {
      const f = await folder("Ops R", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "auto" });
      const d = await doc(f);
      const applied = await propose(d);
      expect(applied.review).toBe("auto");
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      await mirrorRuns();
      const attention = async (who: Person) =>
        (await ok<{ runs: Array<{ run_id: string; you: { ack: boolean } }> }>(person(who), "GET", "/api/runs?filter=attention")).runs.filter(
          (r) => r.run_id === applied.run.id,
        );
      expect(await attention("bo")).toEqual([]);
      expect(await attention("liv")).toEqual([expect.objectContaining({ you: expect.objectContaining({ ack: true }) })]);
      expect((await call(person("bo"), "POST", `/api/docs/${d}/runs/${applied.run.id}/ack`)).status).toBe(403);
      expect((await call(person("liv"), "POST", `/api/docs/${d}/runs/${applied.run.id}/ack`)).status).toBe(200);
    });

    it("names in the mirror only whoever approved what stands accepted", async () => {
      const f = await folder("Policies U", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const d = await doc(f);
      const { run } = await propose(d);
      expect((await decide(person("bo"), d, run.id, "accept")).status).toBe(200);
      const approvedBy = () => (jobs.filter((j) => j.kind === "run_index").at(-1)!.run as RunIndexEntry).approvedBy;
      expect(approvedBy()).toEqual(["bo"]);
      const hunkIds = (await runsOf(person("liv"), d))[0]!.hunks.map((h) => h.id);
      expect((await call(person("liv"), "POST", `/api/docs/${d}/runs/${run.id}/undo`, { hunk_ids: hunkIds })).status).toBe(200);
      expect(approvedBy()).toEqual([]);
      expect((await decide(person("liv"), d, run.id, "reject")).status).toBe(200);
      expect(approvedBy()).toEqual([]);
    });

    it("shows a reader the text of what landed, never of what waits", async () => {
      const f = await folder("Open T", ["bo"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "auto" });
      const d = await doc(f);
      await propose(d);
      const seen = (await runsOf(person("ana"), d))[0]!;
      expect(seen.hunks.map((h) => h.new_string)).toEqual(["Twelve days"]);
      expect(seen.hunks_withheld).toBeUndefined();
    });
  });

  describe("who is told", () => {
    it("tells only the admins who can read it that a level was loosened", async () => {
      const f = await folder("Private P", []);
      await sql`UPDATE folders SET acl_principals = ${["user:liv"]}, own_grants = ${sql.json({ p: ["user:liv"], w: ["user:liv"], c: [] })} WHERE folder_id = ${f}`;
      jobs.length = 0;
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "auto" });
      expect(jobs).toContainEqual(expect.objectContaining({ kind: "audit", action: "folder.agent_mode" }));
      expect(jobs.filter((j) => j.eventType === "REVIEW_LEVEL_LOWERED")).toEqual([]);
    });

    it("lets a folder's owner loosen a page and set it back, and the page's owner tighten it, telling admins only of a loosening", async () => {
      // Cy owns the folder, Bo the page; neither is an admin.
      const f = await folder("Cy team", ["bo"], null, "cy");
      await ok(person("cy"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const d = await doc(f, "bo");
      const lowered = () => jobs.filter((j) => j.eventType === "REVIEW_LEVEL_LOWERED").map((j) => j.recipient).sort();
      jobs.length = 0;
      expect((await ok<{ agent_mode: string }>(person("cy"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "auto" })).agent_mode).toBe("auto");
      expect(lowered()).toEqual(["dee", "liv"]);
      // Stricter, though still below the folder's level: the page's owner may, and nobody is told.
      jobs.length = 0;
      expect((await ok<{ agent_mode: string }>(person("bo"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "review" })).agent_mode).toBe("review");
      expect(lowered()).toEqual([]);
      expect((await call(person("bo"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "auto" })).status).toBe(403);
      // The folder's owner sets it back to following her folder.
      expect((await ok<{ agent_mode: string }>(person("cy"), "PATCH", `/api/docs/${d}/state`, { agent_mode: "colleague" })).agent_mode).toBe("colleague");
      expect((await getDoc(sql, d))?.agent_mode).toBeNull();
      expect(lowered()).toEqual([]);
    });

    it("tells who may approve now when a folder's approver group changes, and the owner and admins while nobody may", async () => {
      const f = await folder("Grouped", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const d = await doc(f);
      const { run } = await propose(d);
      // The inbox mirror, as the job worker writes it, is where a folder's change finds the runs beneath it.
      await mirrorRuns();
      const fanout = async () => {
        const job = jobs.find((j) => j.kind === "notify_approvers") as NotifyApproversMessage;
        await handleNotifyApprovers(env as never, jobDeps(env as never, {}), job);
        return job;
      };
      const notices = async (type: string) =>
        (await sql<{ recipient_alias: string; payload: Record<string, unknown> }[]>`
          SELECT recipient_alias, payload FROM notifications WHERE event_type = ${type} AND resource_id = ${d} ORDER BY recipient_alias`).map((r) => [
          r.recipient_alias,
          r.payload.cause ?? null,
        ]);
      // Only Liv is in `solo`, and she asked: Dee, an admin who can read it, hears it waits for an approver.
      jobs.length = 0;
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { approver_group: "solo" });
      expect(await fanout()).toMatchObject({ runId: run.id, groupBefore: null, askerTold: true });
      expect(await notices("APPROVER_NEEDED")).toEqual([["dee", "group"]]);
      // Bo is in `legal`: he may approve now, and is told.
      jobs.length = 0;
      await ok(person("liv"), "PATCH", `/api/folders/${f}`, { approver_group: "legal" });
      expect(await fanout()).toMatchObject({ runId: run.id, groupBefore: "group:solo" });
      expect(await notices("APPROVAL_WAITING")).toEqual([["bo", null]]);
      // Moved where another group approves, the page's waiting run is heard of again.
      const other = await folder("Grouped elsewhere", ["bo", "cy"]);
      await ok(person("liv"), "PATCH", `/api/folders/${other}`, { agent_mode: "colleague", approver_group: "solo" });
      await mirrorRuns();
      jobs.length = 0;
      await ok(person("liv"), "PATCH", `/api/docs/${d}`, { parent_id: other });
      expect(jobs.find((j) => j.kind === "notify_approvers")).toMatchObject({ runId: run.id, groupBefore: "group:legal" });
    });
  });

  describe("a page in My notes", () => {
    it("takes its agent's edits at once until it is shared, then holds every agent's for review", async () => {
      const { folder: home } = await createHomeFolder(sql, { folderId: "f_home_liv", workspaceId: WS, alias: "liv", title: "My notes" });
      const d = await doc(home.folder_id);
      expect((await getDoc(sql, d))?.notes_shared).toBe(false);
      expect(await ok(person("liv"), "GET", `/api/docs/${d}`)).toMatchObject({ agent_mode: "auto", agent_mode_floors: { folder: "auto", database: null, notes: null } });
      expect((await propose(d)).review).toBe("auto");
      expect(await markdownOf(d)).toContain("Twelve days a year.");

      // Shared with Bo: no agent changes it unseen, Liv's own included.
      await sql`UPDATE docs SET acl_principals = ${["user:liv", "user:bo"]} WHERE doc_id = ${d}`;
      // The level dialog says so, and shows the level the node holds every agent to.
      expect(await ok(person("liv"), "GET", `/api/docs/${d}`)).toMatchObject({
        agent_mode: "review",
        agent_mode_floor: "review",
        agent_mode_floors: { folder: "auto", database: null, notes: "review" },
      });
      const meta = await ok<{ review: { mode: string; reason: string } }>(agent(), "GET", `/api/docs/${d}`);
      expect(meta.review).toEqual({ mode: "review", reason: SHARED_NOTES_REASON });
      const held = await ok<{ review: string; run: { id: string } }>(agent(), "POST", `/api/docs/${d}/propose`, {
        action: "str_replace",
        find: "Twelve days",
        replace: "Fifteen days",
      });
      expect(held.review).toBe("review");
      expect(await markdownOf(d)).toContain("Twelve days a year.");
      expect((await runsOf(person("liv"), d)).find((r) => r.id === held.run.id)?.you?.level).toBe("review");
    });
  });
});
