/**
 * Changes end to end, through the route table with real actors and a real Postgres: an agent's runs
 * across several pages grouped as one change; its card as each reader gets it (never more of the
 * waiting text than the run routes give them); Approve all across pages at different levels; new pages
 * held private until approved, through every place their title could otherwise show; the queue on a
 * hub page; one Slack post and one notice per approver per change; one inbox row per change.
 * Needs TEST_DATABASE_URL; skips without it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import {
  closeClients,
  createClient,
  indexDoc,
  initSchema,
  listExportDocs,
  provisionWorkspace,
  upsertAgentRun,
  type Sql,
} from "@stuga/db";
import { DOC_STORE_VERSION, DocActor } from "@stuga/doc-actor";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import type { IndexMessage, NotifyApproversMessage, NotifyMessage, RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, fsBlobStore, type HostedNamespace } from "@stuga/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { planRemember } from "../agents/remember.js";
import { retrievePassages, searchDocuments } from "../api/search.js";
import type { Ctx, McpCaller } from "../auth/context.js";
import { createNodeSettingsStore } from "../config/settings/node.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { jobDeps } from "../jobs/deps.js";
import { handleNotify, handleNotifyApprovers } from "../jobs/notify.js";
import { handleEvent, handleWebhookDeliver } from "../jobs/webhooks.js";
import { getSessionIndex } from "../mcp/session-index.js";
import { createInternalApi } from "../platform/internal-api.js";
import { fixed } from "../testing/ctx.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_changes_${process.pid}`;
const WS = "ws-chg";
const ORG = `org:${WS}`;
const ORIGIN = "https://node.test";
/** Chgliv asks her agent for the work; Chgsam and Chgcy may approve; Chgdee is an admin; Chgana only reads. */
const PEOPLE = [
  ["chgliv", "owner", "Liv"],
  ["chgdee", "admin", "Dee"],
  ["chgsam", "member", "Sam"],
  ["chgcy", "member", "Cy"],
  ["chgana", "member", "Ana"],
  ["chgzed", "guest", "Zed"],
] as const;
type Person = (typeof PEOPLE)[number][0];
const SLACK = "https://hooks.slack.com/services/T0000/B0000/changeChannelToken";
const HOOK = "https://93.184.215.14/change-hook";

let maintenance: LockSql;
let sql: Sql;
let dir: string;
let namespaces: HostedNamespace[];
let env: Record<string, unknown>;
const jobs: IndexMessage[] = [];

function person(alias: Person): Ctx {
  const [, role, name] = PEOPLE.find(([a]) => a === alias)!;
  return {
    sql,
    surface: "web",
    alias,
    displayName: name,
    isAgent: false,
    principals: [`user:${alias}`, ORG],
    workspaceId: WS,
    role,
    servedOrigin: ORIGIN,
    env,
  } as unknown as Ctx;
}

/** Chgliv's agent, or another person's. */
function agent(of: Person = "chgliv", alias = "agent-chg"): Ctx {
  return {
    sql,
    surface: "api-key",
    alias,
    displayName: "Scout",
    isAgent: true,
    onBehalfOf: of,
    principals: [`agent:${alias}`, `user:${of}`, ORG],
    workspaceId: WS,
    role: PEOPLE.find(([a]) => a === of)![1],
    servedOrigin: ORIGIN,
    env,
    client: "claude-code",
  } as unknown as Ctx;
}

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`${ORIGIN}${path}`, {
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

/** A folder Chgliv makes at `level`, everyone reading it, these people writing besides her. */
async function folder(title: string, level: "review" | "colleague", writers: Person[]): Promise<string> {
  const f = await ok<{ folder_id: string }>(person("chgliv"), "POST", "/api/folders", { title });
  const w = ["user:chgliv", ...writers.map((p) => `user:${p}`)];
  await sql`UPDATE folders SET acl_principals = ${["user:chgliv", ORG]}, acl_writers = ${w},
              own_grants = ${sql.json({ p: ["user:chgliv", ORG], w, c: [] })} WHERE folder_id = ${f.folder_id}`;
  await ok(person("chgliv"), "PATCH", `/api/folders/${f.folder_id}`, { agent_mode: level });
  return f.folder_id;
}

/** A page Chgliv writes herself. */
async function page(parentId: string, title: string, markdown: string): Promise<string> {
  const d = await ok<{ doc_id: string }>(person("chgliv"), "POST", "/api/docs", { title, markdown: `# ${title}\n\n${markdown}\n`, parent_id: parentId });
  return d.doc_id;
}

interface Proposed {
  mode: string;
  run: { id: string; queued_behind?: string };
  change_id?: string;
  change_title?: string;
  queued_behind?: { run_id: string; change_id: string | null; change_title: string | null };
}

const append = (docId: string, text: string, change: Record<string, unknown> = {}, who = agent()) =>
  ok<Proposed>(who, "POST", `/api/docs/${docId}/propose`, { action: "append", text, ...change });

const createPage = (parentId: string, title: string, change: Record<string, unknown> = {}) =>
  ok<{ doc_id: string; held?: boolean; change_id?: string; acl_principals: string[] }>(agent(), "POST", "/api/docs", { title, parent_id: parentId, ...change });

interface CardPage {
  doc_id: string;
  title: string;
  level: string;
  new: boolean;
  state?: string;
  note?: string;
  runs: Array<{ id: string; hunks: Array<{ new_string: string }>; hunks_withheld?: true; you?: { accept: boolean; reject: boolean; queued?: true } }>;
  deciders?: { aliases: string[] };
  queued_behind?: { run_id: string; change_title?: string };
}
interface Card {
  change: { change_id: string; title: string | null; summary: string | null; asked_by: string };
  pages: CardPage[];
}
const card = (who: Person, changeId: string) => ok<Card>(person(who), "GET", `/api/changes/${changeId}`);

interface Decided {
  atomic: false;
  pages: Array<{ doc_id: string; approved: number; declined: number; left: number; reasons: string[]; state?: string }>;
}
const decideChange = (who: Person, changeId: string, decision: "accept" | "reject", note?: string) =>
  ok<Decided>(person(who), "POST", `/api/changes/${changeId}/decision`, { decision, ...(note ? { note } : {}) });

const fetched: Array<{ url: string; body: string }> = [];
const deps = () =>
  jobDeps(env as never, {
    webhookFetch: (async (url: string, init: RequestInit) => {
      fetched.push({ url, body: String(init.body) });
      return new Response("ok", { status: 200 });
    }) as never,
  });

/** Run what the actors and routes queued, as the job worker would: the inbox mirror, the feed and its hooks, and the notices. */
async function work(): Promise<void> {
  const batch = jobs.splice(0, jobs.length);
  for (const m of batch) if (m.kind === "run_index") await upsertAgentRun(sql, m.run as RunIndexEntry);
  for (const m of batch) if (m.kind === "event") await handleEvent(env as never, deps(), m);
  for (const m of batch) if (m.kind === "notify") await handleNotify(env as never, deps(), m as NotifyMessage);
  for (const m of batch) if (m.kind === "notify_approvers") await handleNotifyApprovers(env as never, deps(), m as NotifyApproversMessage);
  const queued = await sql<{ body: { kind: string; webhookId: string; eventId: number } }[]>`
    DELETE FROM jobs WHERE body->>'kind' = 'webhook_deliver' RETURNING body`;
  const sent = [...batch, ...jobs.splice(0, jobs.length)].filter((m): m is Extract<IndexMessage, { kind: "webhook_deliver" }> => m.kind === "webhook_deliver");
  for (const q of [...queued.map((r) => r.body), ...sent]) {
    await handleWebhookDeliver(env as never, deps(), { kind: "webhook_deliver", webhookId: q.webhookId, eventId: q.eventId });
  }
  await sql`DELETE FROM jobs WHERE body->>'kind' = 'notify_deliver'`;
}

const inbox = (who: Person, filter: string) =>
  ok<{ runs: Array<{ run_id: string }>; changes: Array<{ change_id: string; title: string | null; pages: number; run_ids: string[] }> }>(
    person(who),
    "GET",
    `/api/runs?filter=${filter}`,
  );

describe.skipIf(!URL)("changes", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    for (const [alias, , name] of PEOPLE) await sql`INSERT INTO users (alias, username, display_name) VALUES (${alias}, ${alias}, ${name})`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Team", owner: "chgliv", defaultDocAccess: "workspace_view" });
    for (const [alias, role] of PEOPLE.slice(1)) await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, ${alias}, ${role})`;

    dir = mkdtempSync(join(tmpdir(), "stuga-changes-"));
    const snapshots = fsBlobStore(join(dir, "snapshots"));
    const queue = { send: vi.fn(async (m: IndexMessage) => void jobs.push(m)) };
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
    const settings = await createNodeSettingsStore({ sql, dataDir: dir, publicOrigin: ORIGIN });
    const media = fsBlobStore(join(dir, "media"));
    env = {
      sql,
      publicOrigin: ORIGIN,
      extraOrigins: [],
      docs,
      databases,
      snapshots,
      media,
      jobs: queue,
      settings,
      settingsStore: settings,
      searchLanguages: { current: () => [] },
      aiSettings: fixed({ chat: { enabled: false }, embed: { enabled: false, searchCutoff: null } }),
      embeddingDims: EMBEDDING_DIMS,
      nodeId: "node-1",
    };
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

  describe("one ingest is one change", () => {
    let changeId = "";
    let hub = "";
    let held = "";
    let notes = "";

    it("groups an agent's runs on several pages, a new page and pages at different levels, under the change its first write opened", async () => {
      const customers = await folder("Customers", "colleague", ["chgsam", "chgcy"]);
      const team = await folder("Team notes", "review", ["chgsam"]);
      hub = await page(customers, "Customer list", "- Acme");
      notes = await page(team, "Sync log", "- 2026-10-14: Acme renewal.");

      const first = await append(hub, "- Initech", { change_title: "Customer sync, 2026-10-21", change_summary: "Adds Initech as a customer." });
      expect(first.mode).toBe("proposed");
      expect(first.change_id).toMatch(/^chg_[0-9a-f]{12}$/);
      expect(first.change_title).toBe("Customer sync, 2026-10-21");
      changeId = first.change_id!;

      const created = await createPage(customers, "Initech", { change_id: changeId });
      expect(created.held).toBe(true);
      expect(created.change_id).toBe(changeId);
      held = created.doc_id;
      // Filled without naming the change: it is the page's.
      const filled = await append(held, "Initech signed for 30 days.");
      expect(filled.change_id).toBe(changeId);
      const logged = await append(notes, "- 2026-10-21: Initech signed.", { change_id: changeId });
      expect(logged.change_id).toBe(changeId);

      const linked = await sql<{ doc_id: string }[]>`SELECT doc_id FROM wiki_change_runs WHERE change_id = ${changeId} ORDER BY created_at`;
      expect(linked.map((r) => r.doc_id)).toEqual([hub, held, notes]);
      await work();
    });

    it("refuses another agent's change id, and one from nowhere, as unknown", async () => {
      const res = await call(agent("chgsam", "agent-sam"), "POST", `/api/docs/${hub}/propose`, { action: "append", text: "- Hooli", change_id: changeId });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("unknown `change_id`");
      expect((await call(agent(), "POST", `/api/docs/${hub}/propose`, { action: "append", text: "- Hooli", change_id: "chg_000000000000" })).status).toBe(400);
    });

    it("gives an approver the summary first, then each page with its level, who decides it and its text", async () => {
      const seen = await card("chgsam", changeId);
      expect(seen.change).toMatchObject({ title: "Customer sync, 2026-10-21", summary: "Adds Initech as a customer.", asked_by: "chgliv" });
      // In the order the agent first touched them.
      expect(seen.pages.map((p) => [p.title, p.level, p.new])).toEqual([
        ["Customer list", "colleague", false],
        ["Initech", "colleague", true],
        ["Sync log", "review", false],
      ]);
      const hubPage = seen.pages.find((p) => p.doc_id === hub)!;
      expect(hubPage.runs[0]!.hunks.map((h) => h.new_string).join("")).toContain("Initech");
      expect(hubPage.runs[0]!.you).toMatchObject({ accept: true, reject: true });
      expect(hubPage.deciders?.aliases).toEqual(["chgcy", "chgsam"]);
      // Below colleague the page waits for whoever asked: its text is theirs and the owner's, not Chgsam's.
      const log = seen.pages.find((p) => p.doc_id === notes)!;
      expect(log.runs[0]!.hunks_withheld).toBe(true);
      expect(JSON.stringify(log)).not.toContain("Initech signed");
      expect(seen.pages.find((p) => p.doc_id === held)!.state).toBe("held");
    });

    it("gives a reader who reviews none of it the pages they can open, without the agent's words or any waiting text", async () => {
      const seen = await card("chgana", changeId);
      expect(seen.change.title).toBeNull();
      expect(seen.change.summary).toBeNull();
      // The new page is not theirs to know of.
      expect(seen.pages.map((p) => p.doc_id).sort()).toEqual([hub, notes].sort());
      expect(JSON.stringify(seen)).not.toContain("Initech");
      expect(JSON.stringify(seen)).not.toContain("Customer sync");
      for (const p of seen.pages) for (const r of p.runs) expect(r.hunks_withheld).toBe(true);
      // Someone who can open none of its pages hears of no change at all.
      const guest = { ...person("chgzed"), principals: ["user:chgzed"] } as Ctx;
      expect((await call(guest, "GET", `/api/changes/${changeId}`)).status).toBe(404);
    });

    it("lists the change as one row in the inbox, under the tab all its runs together put it in", async () => {
      const sam = await inbox("chgsam", "attention");
      expect(sam.changes.map((c) => c.change_id)).toEqual([changeId]);
      expect(sam.changes[0]).toMatchObject({ title: "Customer sync, 2026-10-21", pages: 3 });
      expect(sam.runs).toEqual([]);
      const liv = await inbox("chgliv", "attention");
      // Chgliv decides the log page herself: the change needs her too.
      expect(liv.changes.map((c) => c.change_id)).toEqual([changeId]);
      const ana = await inbox("chgana", "waiting");
      expect(ana.changes).toEqual([expect.objectContaining({ change_id: changeId, title: null, pages: 2 })]);
      expect(JSON.stringify(ana)).not.toContain("Initech");
    });

    it("tells whoever asked and each approver of the change once, however many pages and runs it has", async () => {
      const rows = await sql<{ recipient_alias: string; event_type: string; resource_url: string }[]>`
        SELECT recipient_alias, event_type, resource_url FROM notifications WHERE id LIKE ${`%change:${changeId}%`} ORDER BY recipient_alias, event_type`;
      expect(rows.map((r) => [r.recipient_alias, r.event_type])).toEqual([
        ["chgcy", "CHANGE_APPROVAL_WAITING"],
        ["chgliv", "CHANGE_PROPOSED"],
        ["chgsam", "CHANGE_APPROVAL_WAITING"],
      ]);
      expect(rows.every((r) => r.resource_url === `${ORIGIN}/review/change/${changeId}?workspace=${WS}`)).toBe(true);
      // Nobody else hears of the new page by name.
      const titles = await sql<{ recipient_alias: string }[]>`SELECT recipient_alias FROM notifications WHERE resource_title = 'Initech' OR payload::text LIKE '%Initech%'`;
      expect(titles.map((r) => r.recipient_alias).filter((a) => a === "chgana" || a === "chgdee")).toEqual([]);
    });

    it("approves, with Approve all, only what each person may approve, and says per page what is left and why", async () => {
      const mine = await decideChange("chgliv", changeId, "accept");
      expect(mine.atomic).toBe(false);
      const byDoc = (d: Decided) => Object.fromEntries(d.pages.map((p) => [p.doc_id, p]));
      expect(byDoc(mine)[notes]).toMatchObject({ approved: 1, left: 0 });
      expect(byDoc(mine)[hub]).toMatchObject({ approved: 0, left: 1, reasons: ["own"] });
      expect(byDoc(mine)[held]).toMatchObject({ approved: 0, left: 1, reasons: ["own"], state: "held" });

      const sams = await decideChange("chgsam", changeId, "accept");
      expect(byDoc(sams)[hub]).toMatchObject({ approved: 1, left: 0 });
      expect(byDoc(sams)[held]).toMatchObject({ approved: 1, left: 0, state: "released" });
      expect(byDoc(sams)[notes]).toMatchObject({ approved: 0, left: 0 });
      await work();
      expect((await inbox("chgsam", "done")).changes.map((c) => c.change_id)).toContain(changeId);
    });

    it("gives the released page its folder's access, and announces it only now", async () => {
      expect((await call(person("chgana"), "GET", `/api/docs/${held}`)).status).toBe(200);
      const [row] = await sql<{ inherits_perms: boolean; acl_principals: string[] }[]>`SELECT inherits_perms, acl_principals FROM docs WHERE doc_id = ${held}`;
      expect(row!.inherits_perms).toBe(true);
      expect(row!.acl_principals).toContain(ORG);
      const created = await sql<{ actor: string }[]>`SELECT actor FROM workspace_events WHERE type = 'doc.created' AND doc_id = ${held}`;
      expect(created).toEqual([{ actor: "agent:agent-chg" }]);
    });
  });

  describe("a new page, until it is approved", () => {
    let changeId = "";
    let secret = "";
    let folderId = "";

    it("is held for whoever asked and those who may approve it", async () => {
      folderId = await folder("Accounts", "colleague", ["chgsam", "chgdee"]);
      // Dee, an admin who can edit here, adds a feed hook and a review channel.
      await ok(person("chgdee"), "POST", "/api/webhooks", { url: HOOK });
      await ok(person("chgdee"), "POST", "/api/webhooks", { kind: "slack", url: SLACK, folder_id: folderId });
      const created = await createPage(folderId, "Zorblax Hooli", { change_title: "Email from Sam, 2026-10-20" });
      changeId = created.change_id!;
      secret = created.doc_id;
      expect(created.held).toBe(true);
      await append(secret, "Zorblax Hooli renews in March.", { change_id: changeId });
      const [row] = await sql<{ acl_principals: string[]; inherits_perms: boolean }[]>`SELECT acl_principals, inherits_perms FROM docs WHERE doc_id = ${secret}`;
      expect(row!.inherits_perms).toBe(false);
      expect(row!.acl_principals.sort()).toEqual(["agent:agent-chg", "user:chgdee", "user:chgliv", "user:chgsam"].sort());
      // As its text would be once flushed: indexed, title and body.
      await indexDoc(sql, {
        embeddingDims: EMBEDDING_DIMS,
        docId: secret,
        snapshotSeq: 1,
        title: "Zorblax Hooli",
        searchText: "# Zorblax Hooli\n\nZorblax Hooli renews in March.",
        embeddingHash: "h-secret",
        chunks: [{ content: "# Zorblax Hooli\n\nZorblax Hooli renews in March.", headingPath: null, embedding: null, embedHash: "c-secret" }],
      });
      await work();
    });

    it("reaches nobody else: not its page, a list, search, retrieval, a plan, the session index or an export", async () => {
      const ana = person("chgana");
      expect((await call(ana, "GET", `/api/docs/${secret}`)).status).toBe(404);
      const listed = await ok<Array<{ doc_id: string }> | { docs: Array<{ doc_id: string }> }>(ana, "GET", `/api/docs?parent_id=${folderId}`);
      expect(JSON.stringify(listed)).not.toContain(secret);
      const found = await searchDocuments(ana, { q: "Zorblax" });
      expect(JSON.stringify(found)).not.toContain(secret);
      const passages = await retrievePassages(agent("chgana", "agent-ana"), { q: "Zorblax Hooli" }, { keywordWhenOff: true });
      expect(JSON.stringify(passages)).not.toContain("Zorblax");
      const plan = await planRemember(agent("chgana", "agent-ana"), [{ text: "Zorblax Hooli renews in March.", topic: "Zorblax Hooli" }]);
      expect(JSON.stringify(plan)).not.toContain(secret);
      // Only the point it was handed says those words: no place, sentence or excerpt does.
      expect(JSON.stringify(plan.points.map((p) => [p.candidates, p.already_saved, p.possibly_replaces]))).not.toContain("Zorblax");
      const anaCaller: McpCaller = { account: agent("chgana", "agent-ana") as never, workspaces: null, readOnly: false };
      const index = await getSessionIndex({ caller: anaCaller, req: new Request(`${ORIGIN}/api/agent/session-index`), url: new globalThis.URL(`${ORIGIN}/api/agent/session-index`), match: [] });
      expect(await index.text()).not.toContain("Zorblax");
      // Not even into an export by someone who may approve it: it is not the workspace's yet.
      const exported = await listExportDocs(sql, ["user:chgdee", ORG], WS, null);
      expect(exported.map((d) => d.doc_id)).not.toContain(secret);
      // Those who may approve it find it, as they may open it.
      expect(JSON.stringify(await searchDocuments(person("chgsam"), { q: "Zorblax" }))).toContain(secret);
    });

    it("is in nobody's feed as made, and no webhook hears of it", async () => {
      const events = await ok<{ events: Array<{ type: string; doc_id: string | null; payload: unknown }> }>(person("chgana"), "GET", "/api/events?after=0&limit=500");
      expect(JSON.stringify(events)).not.toContain(secret);
      const approver = await ok<{ events: Array<{ type: string; doc_id: string | null }> }>(person("chgsam"), "GET", "/api/events?after=0&limit=500");
      expect(approver.events.filter((e) => e.doc_id === secret && e.type === "doc.created")).toEqual([]);
      const toHook = fetched.filter((f) => f.url === HOOK);
      expect(toHook.map((f) => f.body).join("\n")).not.toContain(secret);
      expect(toHook.map((f) => f.body).join("\n")).not.toContain("Zorblax");
    });

    it("is named on its review channel only by its change's title, never its own", async () => {
      const toSlack = fetched.filter((f) => f.url === SLACK);
      expect(toSlack).toHaveLength(1);
      expect(toSlack[0]!.body).toContain("Email from Sam, 2026-10-20");
      expect(toSlack[0]!.body).toContain(`/review/change/${changeId}`);
      expect(toSlack[0]!.body).not.toContain("Zorblax");
    });

    it("goes to the trash when declined, with its note, never announced", async () => {
      const out = await decideChange("chgsam", changeId, "reject", "Not a customer yet.");
      expect(out.pages).toEqual([expect.objectContaining({ doc_id: secret, declined: 1, state: "removed" })]);
      await work();
      const [row] = await sql<{ trashed: boolean; acl_principals: string[] }[]>`SELECT trashed, acl_principals FROM docs WHERE doc_id = ${secret}`;
      expect(row!.trashed).toBe(true);
      expect(row!.acl_principals).not.toContain(ORG);
      const [held] = await sql<{ state: string; note: string }[]>`SELECT state, note FROM wiki_change_pages WHERE doc_id = ${secret}`;
      expect(held).toEqual({ state: "removed", note: "Not a customer yet." });
      expect((await call(person("chgana"), "GET", `/api/docs/${secret}`)).status).toBe(404);
      expect(await sql`SELECT 1 FROM workspace_events WHERE doc_id = ${secret} AND type IN ('doc.created', 'doc.trashed')`).toEqual([]);
      expect(fetched.filter((f) => f.url === HOOK).map((f) => f.body).join("\n")).not.toContain(secret);
      const card = await ok<Card>(person("chgliv"), "GET", `/api/changes/${changeId}`);
      expect(card.pages[0]).toMatchObject({ state: "removed", note: "Not a customer yet." });
    });

    it("is withdrawn when whoever asked declines it, and an approver that cannot see a page cannot approve it", async () => {
      const again = await createPage(folderId, "Initrode", { change_title: "Email from Sam, 2026-10-21" });
      // Ana reads the folder but may not approve there: the change holds nothing she can open.
      expect((await call(person("chgana"), "POST", `/api/changes/${again.change_id}/decision`, { decision: "accept" })).status).toBe(404);
      const out = await decideChange("chgliv", again.change_id!, "reject");
      expect(out.pages).toEqual([expect.objectContaining({ doc_id: again.doc_id, state: "removed" })]);
    });
  });

  describe("a hub page several changes touch", () => {
    it("queues a later change's run behind the earlier one still waiting, and approves it once that one is decided", async () => {
      const f = await folder("Accounts hub", "colleague", ["chgsam"]);
      const hub = await page(f, "Accounts", "- Acme");
      const a = await append(hub, "- Globex", { change_title: "Sync A" });
      const b = await append(hub, "- Initech", { change_title: "Sync B" });
      expect(b.run.id).not.toBe(a.run.id);
      expect(b.queued_behind).toEqual({ run_id: a.run.id, change_id: a.change_id, change_title: "Sync A" });
      await work();

      const seen = await card("chgsam", b.change_id!);
      expect(seen.pages[0]!.queued_behind).toEqual({ run_id: a.run.id, change_id: a.change_id, change_title: "Sync A" });
      expect(seen.pages[0]!.runs[0]!.you).toMatchObject({ accept: false, reject: true, queued: true });
      const early = await decideChange("chgsam", b.change_id!, "accept");
      expect(early.pages[0]).toMatchObject({ approved: 0, left: 1, reasons: ["queued"] });
      // Its own run's card refuses it too, as the actor does.
      expect((await call(person("chgsam"), "POST", `/api/docs/${hub}/runs/${b.run.id}/decision`, { decision: "accept" })).status).toBe(409);

      expect((await decideChange("chgsam", a.change_id!, "accept")).pages[0]).toMatchObject({ approved: 1 });
      expect((await decideChange("chgsam", b.change_id!, "accept")).pages[0]).toMatchObject({ approved: 1, left: 0 });
      const text = await (await call(person("chgsam"), "GET", `/api/docs/${hub}/markdown`)).text();
      expect(text).toMatch(/Globex[\s\S]*Initech/);
    });

    it("never shows a queued run's text to someone who cannot read the waiting text it was proposed on top of", async () => {
      const f = await folder("Ledger", "review", ["chgsam"]);
      const ledger = await page(f, "Ledger", "- Opening balance");
      const a = await append(ledger, "- Refund to Acme", { change_title: "Ledger A" });
      // Raised for the second change, which waits for a colleague, then set back: the first waits for Chgliv.
      await ok(person("chgliv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const b = await append(ledger, "- Refund to Globex", { change_title: "Ledger B" });
      expect(b.queued_behind?.run_id).toBe(a.run.id);
      await ok(person("chgliv"), "PATCH", `/api/folders/${f}`, { agent_mode: "review" });
      const sams = await ok<{ run: { hunks: unknown[]; hunks_withheld?: true; you: { accept: boolean } } }>(
        person("chgsam"),
        "GET",
        `/api/docs/${ledger}/runs/${b.run.id}?full=1`,
      );
      expect(sams.run.hunks_withheld).toBe(true);
      expect(JSON.stringify(sams)).not.toContain("Refund to Acme");
      expect(sams.run.you.accept).toBe(false);
      // Once the first lands, its text is anyone's who reads the page, and the second is Chgsam's to approve.
      await ok(person("chgliv"), "POST", `/api/docs/${ledger}/runs/${a.run.id}/decision`, { decision: "accept" });
      const after = await ok<{ run: { hunks: Array<{ new_string: string }>; you: { accept: boolean } } }>(person("chgsam"), "GET", `/api/docs/${ledger}/runs/${b.run.id}?full=1`);
      expect(after.run.hunks.map((h) => h.new_string).join("")).toContain("Globex");
      expect(after.run.you.accept).toBe(true);
    });
  });

  describe("a new page's title stays its own", () => {
    it("is never a change's title: a change a page opens for itself is untitled, so approvers of its other pages never read it", async () => {
      const hidden = await folder("Deals room", "colleague", ["chgsam"]);
      const open = await folder("Pipeline board", "colleague", ["chgcy"]);
      const created = await createPage(hidden, "Quuxbrand acquisition");
      expect(created.held).toBe(true);
      const changeId = created.change_id!;
      const board = await page(open, "Board", "- nothing yet");
      await append(board, "- A deal is in progress.", { change_id: changeId });
      await work();
      const cys = await card("chgcy", changeId);
      expect(cys.pages.map((p) => p.doc_id)).toEqual([board]);
      expect(JSON.stringify(cys)).not.toContain("Quuxbrand");
      expect(JSON.stringify(await inbox("chgcy", "attention"))).not.toContain("Quuxbrand");
      const notices = await sql<{ payload: unknown; resource_title: string }[]>`SELECT payload, resource_title FROM notifications WHERE recipient_alias = 'chgcy'`;
      expect(JSON.stringify(notices)).not.toContain("Quuxbrand");
    });

    it("is posted to no review channel by a run outside its change", async () => {
      const f = await folder("Board room", "colleague", ["chgsam", "chgdee"]);
      await ok(person("chgdee"), "POST", "/api/webhooks", { kind: "slack", url: `${SLACK}/board`, folder_id: f });
      const created = await createPage(f, "Plughmex merger", { change_title: "Board memo" });
      // Another of Chgliv's agents writes to it, naming no change.
      await append(created.doc_id, "Plughmex is in talks.", {}, agent("chgliv", "agent-chg2"));
      await work();
      expect(fetched.filter((x) => x.url === `${SLACK}/board`).map((x) => x.body).join("\n")).not.toContain("Plughmex");
    });
  });

  describe("a large run", () => {
    // Past the 256 KB a run summary carries its hunks up to.
    const big = (word: string) => Array.from({ length: 7000 }, (_, i) => `- ${word} line ${i}, with enough words to make it long.`).join("\n");

    it("is released once approved, however large its text", async () => {
      const f = await folder("Archive room", "colleague", ["chgsam"]);
      const created = await createPage(f, "Large page", { change_title: "Archive import" });
      await append(created.doc_id, big("Archive"), { change_id: created.change_id });
      const out = await decideChange("chgsam", created.change_id!, "accept");
      expect(out.pages[0]).toMatchObject({ approved: 1, left: 0, state: "released" });
      expect((await call(person("chgana"), "GET", `/api/docs/${created.doc_id}`)).status).toBe(200);
    });

    it("narrows a queued run's text over a large run it was stacked on, as over a small one", async () => {
      const f = await folder("Big ledger", "review", ["chgsam"]);
      const ledger = await page(f, "Big ledger", "- Opening balance");
      const a = await append(ledger, big("Hidden"), { change_title: "Big A" });
      // Its summary leaves its hunks out: the queue still knows what it holds.
      const summary = await ok<{ run: { hunks_truncated?: boolean } }>(person("chgliv"), "GET", `/api/docs/${ledger}/runs/${a.run.id}`);
      expect(summary.run.hunks_truncated).toBe(true);
      await ok(person("chgliv"), "PATCH", `/api/folders/${f}`, { agent_mode: "colleague" });
      const b = await append(ledger, "- Refund to Globex", { change_title: "Big B" });
      expect(b.queued_behind?.run_id).toBe(a.run.id);
      await ok(person("chgliv"), "PATCH", `/api/folders/${f}`, { agent_mode: "review" });
      const sams = await call(person("chgsam"), "GET", `/api/docs/${ledger}/runs/${b.run.id}?full=1`);
      const text = await sams.text();
      expect(text).not.toContain("Hidden line");
      expect(JSON.parse(text).run.hunks_withheld).toBe(true);
    });
  });

  describe("a held page that is locked, or a held database's row pages", () => {
    it("keeps a locked held page out of the trash when it is declined", async () => {
      const f = await folder("Locked room", "colleague", ["chgsam"]);
      const created = await createPage(f, "Locked page", { change_title: "Locked memo" });
      await append(created.doc_id, "Text.", { change_id: created.change_id });
      await sql`UPDATE docs SET locked = TRUE WHERE doc_id = ${created.doc_id}`;
      await decideChange("chgsam", created.change_id!, "reject");
      const [row] = await sql<{ trashed: boolean }[]>`SELECT trashed FROM docs WHERE doc_id = ${created.doc_id}`;
      expect(row!.trashed).toBe(false);
      const [held] = await sql<{ state: string }[]>`SELECT state FROM wiki_change_pages WHERE doc_id = ${created.doc_id}`;
      expect(held!.state).toBe("held");
    });

    it("holds a held database's row pages with it, and lets them out with it", async () => {
      const f = await folder("Ledger room", "colleague", ["chgsam"]);
      const hook = `${HOOK}/rows`;
      await ok(person("chgdee"), "POST", "/api/webhooks", { url: hook });
      const db = await ok<{ doc_id: string; held?: boolean; change_id?: string }>(agent(), "POST", "/api/docs", { title: "Accounts", doc_type: "database", parent_id: f, change_title: "Ledger setup" });
      expect(db.held).toBe(true);
      const schema = await ok<{ tables: Array<{ table_id: string }> }>(person("chgliv"), "GET", `/api/databases/${db.doc_id}/schema`);
      const tableId = schema.tables[0]!.table_id;
      // Chgliv adds a row herself and opens its page while the database is held.
      const inserted = await ok<{ row_ids?: string[]; minted?: { row_ids?: string[] } }>(person("chgliv"), "POST", `/api/databases/${db.doc_id}/tables/${tableId}/rows`, { rows: [{ Name: "Quuxcorp secret" }] });
      const rowIds = inserted.row_ids ?? inserted.minted?.row_ids ?? [];
      const rowId = rowIds[0]!;
      const rowPage = await ok<{ doc_id: string }>(person("chgliv"), "POST", `/api/databases/${db.doc_id}/tables/${tableId}/rows/${rowId}/page`, {});
      await work();
      expect((await call(person("chgana"), "GET", `/api/docs/${rowPage.doc_id}`)).status).toBe(404);
      expect(fetched.filter((x) => x.url === hook).map((x) => x.body).join("\n")).not.toContain("Quuxcorp");
      expect((await listExportDocs(sql, ["user:chgliv", ORG], WS, null)).map((d) => d.doc_id)).not.toContain(rowPage.doc_id);
      // The agent's change to it is approved: the database and its row page are the folder's now.
      await ok(agent(), "POST", `/api/databases/${db.doc_id}/tables/${tableId}/rows`, { rows: [{ Name: "Initech" }], change_id: db.change_id });
      expect((await decideChange("chgsam", db.change_id!, "accept")).pages[0]).toMatchObject({ state: "released" });
      expect((await call(person("chgana"), "GET", `/api/docs/${db.doc_id}`)).status).toBe(200);
      expect((await call(person("chgana"), "GET", `/api/docs/${rowPage.doc_id}`)).status).toBe(200);
    });
  });

  describe("a database in a change", () => {
    it("links the agent's database runs to the change, and its card lists them", async () => {
      const f = await folder("Pipeline", "colleague", ["chgsam"]);
      const db = await ok<{ doc_id: string }>(person("chgliv"), "POST", "/api/docs", { title: "Deals", doc_type: "database", parent_id: f });
      const schema = await ok<{ tables: Array<{ table_id: string }> }>(person("chgliv"), "GET", `/api/databases/${db.doc_id}/schema`);
      const tableId = schema.tables[0]!.table_id;
      const doc = await append(await page(f, "Pipeline notes", "- none yet"), "- Initech deal", { change_title: "Deal review" });
      const rows = await ok<{ mode: string; change_id?: string }>(agent(), "POST", `/api/databases/${db.doc_id}/tables/${tableId}/rows`, {
        rows: [{ Name: "Initech" }],
        change_id: doc.change_id,
      });
      expect(rows).toMatchObject({ mode: "proposed", change_id: doc.change_id });
      const seen = await card("chgsam", doc.change_id!);
      expect(seen.pages.map((p) => p.doc_id)).toContain(db.doc_id);
      const out = await decideChange("chgsam", doc.change_id!, "accept");
      expect(out.pages.find((p) => p.doc_id === db.doc_id)).toMatchObject({ approved: 1, left: 0 });
    });
  });
});
