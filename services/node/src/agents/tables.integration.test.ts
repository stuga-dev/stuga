/**
 * Pages and tables, end to end, through the route table with real actors and a real Postgres: Save to
 * Stuga planning a fact into the row it names (or a new row), the cell as it reads now; Ask Stuga's rows
 * beside its passages, with who last wrote each and what waits for it; the Index's databases with their
 * rows and last change; the Log naming the table and rows a change touched; and the check finding a link
 * to a deleted row. Nothing names a database, a row or a waiting change its reader cannot see.
 * Needs TEST_DATABASE_URL; skips without it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import { closeClients, createClient, initSchema, provisionWorkspace, upsertAgentRun, type Sql } from "@stuga/db";
import { DOC_STORE_VERSION, DocActor } from "@stuga/doc-actor";
import type { RecalledRow, RememberRowCandidate, RetrieveBody, SearchBody } from "@stuga/agent-surface/backend";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import type { WikiIndex, WikiLint, WikiLog } from "@stuga/protocol/domain/wiki";
import type { IndexMessage, RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, fsBlobStore, type HostedNamespace } from "@stuga/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retrievePassages, searchDocuments } from "../api/search.js";
import type { Ctx } from "../auth/context.js";
import { createNodeSettingsStore } from "../config/settings/node.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { dispatchJob } from "../jobs/worker.js";
import { nodeBackend } from "../mcp/backend.js";
import { createInternalApi } from "../platform/internal-api.js";
import { fixed } from "../testing/ctx.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { planRemember } from "./remember.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_tables_${process.pid}`;
const WS = "ws-tables";
const ORG = `org:${WS}`;
const ORIGIN = "https://node.test";
/** Tbliv owns the workspace and asks her agent; Tbsam edits Customers and Sales; Tbana only reads; Tbdee keeps her deals. */
const PEOPLE = [
  ["tbliv", "owner", "Liv"],
  ["tbsam", "member", "Sam"],
  ["tbana", "member", "Ana"],
  ["tbdee", "member", "Dee"],
] as const;
type Person = (typeof PEOPLE)[number][0];

let maintenance: LockSql;
let sql: Sql;
let dir: string;
let namespaces: HostedNamespace[];
let env: Record<string, unknown>;
const jobs: IndexMessage[] = [];

function person(alias: Person): Ctx {
  const [, role, name] = PEOPLE.find(([a]) => a === alias)!;
  return { sql, surface: "web", alias, displayName: name, isAgent: false, principals: [`user:${alias}`, ORG], workspaceId: WS, role, servedOrigin: ORIGIN, env } as unknown as Ctx;
}

function agent(of: Person = "tbliv"): Ctx {
  const alias = `agent-${of}`;
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
  const req = new Request(`${ORIGIN}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return routeWorkspaceRequest(ctx, req);
}

async function ok<T = Record<string, unknown>>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(ctx, method, path, body);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Run what the actors queued, as the job worker would; and index each database now, as its quiet timer would later. */
async function work(databases: readonly string[] = []): Promise<void> {
  for (let round = 0; round < 5 && jobs.length > 0; round++) {
    const batch = jobs.splice(0, jobs.length);
    for (const m of batch) if (m.kind === "index_doc" && m.reason !== "database_changed") await dispatchJob(env as never, m);
    for (const m of batch) if (m.kind === "run_index") await upsertAgentRun(sql, m.run as RunIndexEntry);
  }
  for (const docId of databases) await dispatchJob(env as never, { kind: "index_doc", docId, reason: "database_changed" });
}

async function folder(title: string, readers: string[], writers: string[], level: "review" | "colleague" = "review"): Promise<string> {
  const f = await ok<{ folder_id: string }>(person("tbliv"), "POST", "/api/folders", { title });
  await sql`UPDATE folders SET acl_principals = ${readers}, acl_writers = ${writers}, own_grants = ${sql.json({ p: readers, w: writers, c: [] })} WHERE folder_id = ${f.folder_id}`;
  if (level !== "review") await ok(person("tbliv"), "PATCH", `/api/folders/${f.folder_id}`, { agent_mode: level });
  return f.folder_id;
}

interface Table {
  table_id: string;
  columns: Array<{ column_id: string; display: string }>;
}

/** A database `who` makes in a folder, with one table of these columns and rows; its id, its table and its rows' ids. */
async function database(
  who: Person,
  parentId: string,
  title: string,
  columns: Array<{ name: string; type: string; choices?: string[] }>,
  rows: Array<Record<string, string>>,
): Promise<{ id: string; table: Table; rowIds: string[] }> {
  const d = await ok<{ doc_id: string }>(person(who), "POST", "/api/docs", { title, doc_type: "database", parent_id: parentId, table: title, columns });
  const schema = await ok<{ tables: Table[] }>(person(who), "GET", `/api/databases/${d.doc_id}/schema`);
  const table = schema.tables[0]!;
  const inserted = rows.length > 0 ? await ok<{ row_ids: string[] }>(person(who), "POST", `/api/databases/${d.doc_id}/tables/${table.table_id}/rows`, { rows }) : { row_ids: [] };
  await work([d.doc_id]);
  return { id: d.doc_id, table, rowIds: inserted.row_ids };
}

/** A person's own edit, flushed and so indexed. */
async function edit(docId: string, find: string, replace: string, by: Person = "tbliv"): Promise<void> {
  const res = await (env.docs as HostedNamespace).get(docId).fetch(`http://actor/apply-edits?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ str_edits: [{ old_string: find, new_string: replace }], agent: by, flush: true }),
  });
  if (!res.ok) throw new Error(`edit ${docId}: ${res.status} ${await res.text()}`);
}

const CUSTOMER_COLUMNS = [
  { name: "Name", type: "text" },
  { name: "Contact", type: "text" },
  { name: "Refund window", type: "text" },
  { name: "Plan", type: "single_select", choices: ["Free", "Pro", "Team"] },
];

const rowCandidates = (c: Array<{ kind: string }>) => c.filter((x): x is RememberRowCandidate => x.kind === "row");

describe.skipIf(!URL)("pages and tables", () => {
  let customers: Awaited<ReturnType<typeof database>>;
  let partners: Awaited<ReturnType<typeof database>>;
  let deals: Awaited<ReturnType<typeof database>>;
  let customersFolder = "";

  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    for (const [alias, , name] of PEOPLE) await sql`INSERT INTO users (alias, username, display_name) VALUES (${alias}, ${alias}, ${name})`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Team", owner: "tbliv", defaultDocAccess: "workspace_view" });
    for (const [alias, role] of PEOPLE.slice(1)) await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, ${alias}, ${role})`;
    for (const [alias] of PEOPLE) await sql`INSERT INTO api_keys (key_id, secret_hash, agent_id, owner, workspace_id) VALUES (${`k_${alias}`}, 'x', ${`agent-${alias}`}, ${alias}, ${WS})`;

    dir = mkdtempSync(join(tmpdir(), "stuga-tables-"));
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
    env = {
      sql,
      publicOrigin: ORIGIN,
      extraOrigins: [],
      docs,
      databases,
      snapshots,
      media: fsBlobStore(join(dir, "media")),
      jobs: queue,
      settings,
      settingsStore: settings,
      searchLanguages: { current: () => [] },
      aiSettings: fixed({ chat: { enabled: false }, embed: { enabled: false, searchCutoff: null } }),
      embeddingDims: EMBEDDING_DIMS,
      nodeId: "node-1",
    };

    customersFolder = await folder("Customers", ["user:tbliv", ORG], ["user:tbliv", "user:tbsam"]);
    const partnersFolder = await folder("Partners", ["user:tbliv", ORG], ["user:tbsam"]);
    const dealsFolder = await folder("Deals", ["user:tbdee"], ["user:tbdee"]);
    customers = await database("tbliv", customersFolder, "Customers", CUSTOMER_COLUMNS, [
      { Name: "Initech", Contact: "Bo Chen", "Refund window": "30 days", Plan: "Pro" },
      { Name: "Globex", Contact: "Ana Ruiz", "Refund window": "14 days", Plan: "Team" },
      { Name: "環球貿易", Contact: "王芳", "Refund window": "7 days", Plan: "Free" },
    ]);
    partners = await database("tbsam", partnersFolder, "Partner list", [{ name: "Name", type: "text" }, { name: "Contact", type: "text" }], [
      { Name: "Initech", Contact: "Carl Diaz" },
    ]);
    deals = await database("tbdee", dealsFolder, "Deals", [{ name: "Name", type: "text" }, { name: "Contact", type: "text" }], [
      { Name: "Initech", Contact: "Secret Person" },
    ]);
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

  describe("Save to Stuga", () => {
    it("plans a fact a table's columns name into the row it names, each cell as it reads now", async () => {
      const plan = await planRemember(agent(), [{ text: "Initech's contact is Ana Ruiz." }]);
      const point = plan.points[0]!;
      const [row] = rowCandidates(point.candidates);
      expect(point.candidates[0]).toBe(row);
      expect(row).toMatchObject({
        kind: "row",
        database_id: customers.id,
        title: "Customers",
        folder_path: ["Customers"],
        table: "Customers",
        table_name: "customers",
        row: { row_id: customers.rowIds[0], title: "Initech" },
        title_column: "Name",
        fills: [{ column: "Contact", type: "text", now: "Bo Chen", possibly_replaces: true }],
        review: { mode: "review" },
        url: `${ORIGIN}/doc/${customers.id}?table=${customers.table.table_id}&row=${customers.rowIds[0]}`,
      });
      expect(row!.columns.map((c) => c.name)).toEqual(["Name", "Contact", "Refund window", "Plan"]);
      expect(row!.why).toContain('holds "Bo Chen"');
      // The cell it may change, as a sentence would be named.
      expect(point.possibly_replaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ doc_id: customers.id, row: "Initech", column: "Contact", sentence: "Initech · Contact: Bo Chen", can_edit: true }),
          // Sam's partner list Liv can read and not edit: named, never offered.
          expect.objectContaining({ doc_id: partners.id, row: "Initech", column: "Contact", can_edit: false }),
        ]),
      );
      expect(point.candidates.map((c) => (c.kind === "row" ? c.database_id : null))).not.toContain(partners.id);

      // A page found by one word of the topic is no place for a fact a row takes.
      const onboarding = await ok<{ doc_id: string }>(person("tbliv"), "POST", "/api/docs", { title: "First week" });
      await edit(onboarding.doc_id, "", "# First week\n\n## Accounts\n\nIT sets up the laptop and email on the first day.\n");
      await work();
      const topical = (await planRemember(agent(), [{ text: "Ana Ruiz is the contact at Initech.", topic: "Initech account" }])).points[0]!;
      expect(topical.candidates.map((c) => c.kind)).toEqual(["row"]);
    });

    it("names a row whatever its case, its width or its Chinese script, and says a cell holds the point already", async () => {
      const plan = await planRemember(agent(), [
        { text: "INITECH's refund window is 30 days." },
        { text: "Ｉｎｉｔｅｃｈ is on the Pro plan." },
        { text: "环球贸易的联系人是李雷。" },
      ]);
      const [upper, wide, chinese] = plan.points;
      expect(rowCandidates(upper!.candidates)[0]).toMatchObject({
        row: { title: "Initech" },
        fills: [{ column: "Refund window", now: "30 days", already_saved: true }],
      });
      expect(upper!.already_saved).toEqual([expect.objectContaining({ doc_id: customers.id, row: "Initech", column: "Refund window", sentence: "Initech · Refund window: 30 days" })]);
      expect(rowCandidates(wide!.candidates)[0]).toMatchObject({ row: { title: "Initech" }, fills: [{ column: "Plan", choice: "Pro", now: "Pro", already_saved: true }] });
      expect(rowCandidates(chinese!.candidates)[0]).toMatchObject({ row: { title: "環球貿易" } });
    });

    it("offers a new row for a name no row has, its title column first, and corrects a cell another value holds", async () => {
      const plan = await planRemember(agent(), [
        { text: "New customer Hooli is on the Pro plan." },
        { text: "Globex is on the Free plan now, not Team." },
      ]);
      const [hooli, globex] = plan.points;
      expect(rowCandidates(hooli!.candidates)[0]).toMatchObject({
        row: null,
        title_column: "Name",
        fills: [
          { column: "Name", now: null },
          { column: "Plan", choice: "Pro", now: null },
        ],
      });
      expect(rowCandidates(hooli!.candidates)[0]!.why).toContain("a new row");
      expect(rowCandidates(globex!.candidates)[0]).toMatchObject({ row: { title: "Globex" }, fills: [{ column: "Plan", choice: "Free", now: "Team", possibly_replaces: true }] });
      // A point that names the old value beside the new says nothing of the old but that it was.
      const correction = (await planRemember(agent(), [{ text: "Globex's refund window is 30 days. It was previously recorded as 14 days." }])).points[0]!;
      expect(rowCandidates(correction.candidates)[0]!.fills).toEqual([expect.objectContaining({ column: "Refund window", now: "14 days", possibly_replaces: true })]);
      expect(correction.already_saved.filter((a) => a.doc_id === customers.id)).toEqual([]);
    });

    it("never reads a database the person cannot see: another's, or one a change holds", async () => {
      // Sam's agent makes a database where AI edits wait for a colleague, in a change: held until approved.
      const sales = await folder("Sales", ["user:tbliv", ORG], ["user:tbliv", "user:tbsam"], "colleague");
      const held = await nodeBackend(agent("tbsam")).createDoc({ title: "Leads", parent_id: sales, doc_type: "database", table: "Leads", columns: [{ name: "Name", type: "text" }, { name: "Contact", type: "text" }], change_title: "Leads, 2026-10-22" });
      expect(held).toMatchObject({ held: true });
      const heldId = (held as { doc_id: string }).doc_id;
      const schema = await ok<{ tables: Table[] }>(person("tbsam"), "GET", `/api/databases/${heldId}/schema`);
      await ok(person("tbsam"), "POST", `/api/databases/${heldId}/tables/${schema.tables[0]!.table_id}/rows`, { rows: [{ Name: "Initech", Contact: "Held Person" }] });
      await work([heldId]);
      for (const who of ["tbliv", "tbana"] as const) {
        const said = JSON.stringify(await planRemember(agent(who), [{ text: "Initech's contact is Ana Ruiz." }]));
        expect(said).not.toContain("Secret Person");
        expect(said).not.toContain(deals.id);
        if (who === "tbana") expect(said).not.toContain("Held Person");
        const asked = JSON.stringify(await nodeBackend(agent(who)).retrieve({ q: "Who is Initech's contact?" }));
        expect(asked).not.toContain("Secret Person");
        if (who === "tbana") expect(asked).not.toContain("Held Person");
      }
      // Ana reads Customers and edits nothing: told what the cell holds, offered no row.
      const ana = (await planRemember(agent("tbana"), [{ text: "Initech's contact is Ana Ruiz." }])).points[0]!;
      expect(rowCandidates(ana.candidates)).toEqual([]);
      expect(ana.possibly_replaces).toEqual(expect.arrayContaining([expect.objectContaining({ doc_id: customers.id, column: "Contact", can_edit: false })]));
      // Sam's own agent reads the database it made.
      expect(JSON.stringify(await nodeBackend(agent("tbsam")).retrieve({ q: "Who is Initech's contact?" }))).toContain("Held Person");
    });
  });

  describe("Ask Stuga", () => {
    it("answers an agent's retrieve and search with the rows whose cells hold the question's words, and a person's as before", async () => {
      const retrieved = (await nodeBackend(agent()).retrieve({ q: "Who is Globex's contact?" })) as RetrieveBody;
      const globex = retrieved.rows![0]!;
      expect(globex).toMatchObject({
        database_id: customers.id,
        title: "Customers",
        table: "Customers",
        table_name: "customers",
        row_id: customers.rowIds[1],
        row_title: "Globex",
        cells: { Name: "Globex", Contact: "Ana Ruiz", "Refund window": "14 days", Plan: "Team" },
        matched: ["Name", "Contact"],
        last_edited_by: [{ kind: "person", name: "Liv" }],
      });
      expect(globex.updated_at).toEqual(expect.any(String));
      // The names `query` reads the table by, for a precise question over it.
      expect(retrieved.tables).toEqual([
        {
          database_id: customers.id,
          title: "Customers",
          table_id: customers.table.table_id,
          table: "Customers",
          table_name: "customers",
          columns: { Name: "name", Contact: "contact", "Refund window": "refund_window", Plan: "plan_x" },
        },
      ]);
      expect(retrieved.rows!.map((r) => r.row_title)).not.toContain("Initech");

      const searched = (await nodeBackend(agent()).searchDocs({ q: "Which customers are on the Pro plan?" })) as SearchBody;
      expect(searched.rows!.map((r) => [r.title, r.row_title])).toEqual([["Customers", "Initech"]]);

      // A person's answers carry no rows.
      const rest = await retrievePassages(person("tbliv"), { q: "Who is Globex's contact?" });
      expect(rest).not.toHaveProperty("rows");
      expect(await searchDocuments(person("tbliv"), { q: "Globex" })).not.toHaveProperty("rows");
    });

    it("says when more rows hold the words than are listed, for `query` to read them all", async () => {
      await ok(person("tbliv"), "POST", `/api/databases/${customers.id}/tables/${customers.table.table_id}/rows`, {
        rows: ["Umbrella", "Stark", "Wayne", "Tyrell", "Cyberdyne"].map((Name) => ({ Name, Plan: "Pro" })),
      });
      await work([customers.id]);
      const searched = (await nodeBackend(agent()).searchDocs({ q: "Which customers are on the Pro plan?" })) as SearchBody;
      expect(searched.rows).toHaveLength(5);
      expect(searched.rows_more).toEqual([{ database_id: customers.id, table: "Customers", table_name: "customers", rows: 6 }]);
    });

    it("tells the user's own waiting change to a cell as it would land, counts another's, and a new row of theirs as waiting", async () => {
      const mine = await nodeBackend(agent()).mutateDatabase(customers.id, {
        action: "update_rows",
        table_id: customers.table.table_id,
        updates: [{ _id: customers.rowIds[0]!, values: { Contact: "Ana Ruiz" } }],
      });
      expect(mine).toMatchObject({ mode: "proposed" });
      const sams = await nodeBackend(agent("tbsam")).mutateDatabase(customers.id, {
        action: "update_rows",
        table_id: customers.table.table_id,
        updates: [{ _id: customers.rowIds[0]!, values: { "Refund window": "45 days" } }],
      });
      expect(sams).toMatchObject({ mode: "proposed" });
      await nodeBackend(agent()).mutateDatabase(customers.id, { action: "insert_rows", table_id: customers.table.table_id, rows: [{ Name: "Hooli", Plan: "Pro" }] });
      await work();

      const asked = (await nodeBackend(agent()).retrieve({ q: "Who is Initech's contact?" })) as RetrieveBody;
      const initech = asked.rows!.find((r) => r.database_id === customers.id && r.row_title === "Initech")!;
      expect(initech.cells.Contact).toBe("Bo Chen");
      expect(initech.pending_changes).toEqual([
        { asked_by: "user", waits_for: "review", changes: 1, since: expect.any(String), proposed: [{ approved_now: "Bo Chen", after_approval: "Ana Ruiz", column: "Contact" }] },
      ]);
      // Sam's change is counted for the table, never tied to the row it touches nor quoted.
      expect(asked.tables_waiting).toEqual([
        { database_id: customers.id, title: "Customers", asked_by: "others", waits_for: "review", changes: 1, since: expect.any(String) },
      ]);
      expect(JSON.stringify(asked)).not.toContain("45 days");
      expect(JSON.stringify(asked.rows)).not.toContain('"others"');

      const hooli = ((await nodeBackend(agent()).retrieve({ q: "Hooli" })) as RetrieveBody).rows!.find((r: RecalledRow) => r.row_title === "Hooli")!;
      expect(hooli).toMatchObject({ waiting_row: true, cells: {}, pending_changes: [{ asked_by: "user", changes: 1, proposed: [{ approved_now: "", after_approval: "Name: Hooli · Plan: Pro" }] }] });
      // Another's new row is nobody's to see yet.
      expect(JSON.stringify(await nodeBackend(agent("tbsam")).retrieve({ q: "Hooli" }))).not.toContain("Hooli");

      // Saving the same again finds it waiting, first.
      const again = await planRemember(agent(), [{ text: "Initech's contact is Ana Ruiz." }, { text: "New customer Hooli is on the Pro plan." }]);
      expect(rowCandidates(again.points[0]!.candidates)[0]!.fills[0]).toMatchObject({ column: "Contact", waiting: { after_approval: "Ana Ruiz", waits_for: "review" } });
      expect(again.points[0]!.candidates[0]!.kind).toBe("row");
      expect(rowCandidates(again.points[1]!.candidates)[0]).toMatchObject({ row: null, waiting_row: { title: "Hooli", waits_for: "review" } });
    });
  });

  describe("the wiki", () => {
    it("lists each database in the Index under its folder, with its rows and last change", async () => {
      const index = await ok<WikiIndex>(person("tbana"), "GET", "/api/wiki/index");
      const section = index.sections.find((s) => s.folder_id === customersFolder)!;
      expect(section.pages).toEqual([
        expect.objectContaining({ doc_id: customers.id, doc_type: "database", row_count: 8, changed_by: [{ kind: "person", name: "Liv" }], changed_at: expect.any(String) }),
      ]);
      expect(JSON.stringify(index)).not.toContain(deals.id);
      // The agent's index says the same, in its words.
      const viaAgent = await nodeBackend(agent()).wikiIndex(customersFolder);
      expect(JSON.stringify(viaAgent)).toContain('"row_count":8');
    });

    it("names the table and the rows a change touched in the Log, as the table reads now", async () => {
      const runs = await sql<{ run_id: string }[]>`SELECT run_id FROM agent_runs WHERE doc_id = ${customers.id} AND agent_alias = 'agent-tbliv'`;
      await ok(person("tbliv"), "POST", `/api/databases/${customers.id}/runs/${runs[0]!.run_id}/decision`, { decision: "accept" });
      await work([customers.id]);
      const log = await ok<WikiLog>(person("tbana"), "GET", "/api/wiki/log");
      const page = log.entries.flatMap((e) => e.pages).find((p) => p.doc_id === customers.id)!;
      expect(page.tables).toEqual([{ table: "Customers", rows: expect.arrayContaining(["Initech", "Hooli"]), count: 2 }]);
      // A change too large to keep its row ids is named by its table, and counted.
      const big = await nodeBackend(agent("tbsam")).mutateDatabase(partners.id, {
        action: "insert_rows",
        table_id: partners.table.table_id,
        rows: Array.from({ length: 300 }, (_, i) => ({ Name: `Partner ${i}`, Contact: "x".repeat(300) })),
      });
      const bigRun = (big as { run: { id: string } }).run.id;
      await ok(person("tbsam"), "POST", `/api/databases/${partners.id}/runs/${bigRun}/decision`, { decision: "accept" });
      await work([partners.id]);
      const later = await ok<WikiLog>(person("tbliv"), "GET", "/api/wiki/log");
      expect(later.entries.flatMap((e) => e.pages).find((p) => p.run_id === bigRun)!.tables).toEqual([{ table: "Partner list", rows: [], count: 300 }]);
      // The cell landed, under the agent's name.
      const row = ((await nodeBackend(agent("tbana")).retrieve({ q: "Who is Initech's contact?" })) as RetrieveBody).rows!.find((r) => r.row_title === "Initech")!;
      expect(row).toMatchObject({ cells: { Contact: "Ana Ruiz" }, last_edited_by: [{ kind: "agent", name: "Liv's agent" }] });
      // The Index's last change is the agent's.
      const index = await ok<WikiIndex>(person("tbana"), "GET", "/api/wiki/index");
      expect(index.sections.flatMap((s) => s.pages).find((p) => p.doc_id === customers.id)).toMatchObject({ row_count: 9, changed_by: [{ kind: "agent", name: "Liv" }] });
    });

    it("finds a link or a citation of a row since deleted, and refuses a citation of a row that is not there", async () => {
      const notes = await ok<{ doc_id: string }>(person("tbliv"), "POST", "/api/docs", { title: "Account notes", parent_id: customersFolder });
      const [initech, globex] = customers.rowIds;
      const t = customers.table.table_id;
      await edit(notes.doc_id, "", `# Account notes\n\nSee [Globex](/doc/${customers.id}?table=${t}&row=${globex}) and [Initech](/doc/${customers.id}?table=${t}&row=${initech}).\n`);
      await work();
      const cited = await ok<{ run: { id: string } }>(agent(), "POST", `/api/docs/${notes.doc_id}/propose`, {
        action: "cited_edits",
        edits: [{ old_string: "See [Globex]", new_string: "Globex pays on time [^1]. See [Globex]" }],
        citations: [{ n: 1, doc_id: customers.id, title: "Customers", heading_path: "Globex", content: "Globex", table_id: t, row_id: globex }],
      });
      await ok(person("tbliv"), "POST", `/api/docs/${notes.doc_id}/runs/${cited.run.id}/decision`, { decision: "accept" });
      await work();
      const [link] = await sql<{ target_rows: string[] }[]>`SELECT target_rows FROM doc_links WHERE doc_id = ${notes.doc_id} AND kind = 'citation'`;
      expect(link!.target_rows).toEqual([`${t}.${globex}`]);
      expect((await ok<WikiLint>(person("tbana"), "GET", "/api/wiki/lint")).broken_links).toEqual([]);

      await ok(person("tbliv"), "POST", `/api/databases/${customers.id}/tables/${t}/rows/delete`, { row_ids: [globex] });
      await work([customers.id]);
      const lint = await ok<WikiLint>(person("tbana"), "GET", "/api/wiki/lint");
      expect(lint.broken_links).toEqual([
        {
          doc_id: notes.doc_id,
          title: "Account notes",
          path: ["Customers"],
          links: [
            { href: `/doc/${customers.id}?table=${t}&row=${globex}`, kind: "citation", reason: "row_deleted", title: "Customers" },
            { href: `/doc/${customers.id}?table=${t}&row=${globex}`, kind: "link", reason: "row_deleted", title: "Customers" },
          ],
        },
      ]);

      // A link to a row of a database the reader cannot open is not_found to them, whether the row is there or
      // not; to Dee, who opens it, it is broken once the row is gone.
      const dealNotes = await ok<{ doc_id: string }>(person("tbliv"), "POST", "/api/docs", { title: "Deal notes", parent_id: customersFolder });
      const dealHref = `/doc/${deals.id}?table=${deals.table.table_id}&row=${deals.rowIds[0]}`;
      await edit(dealNotes.doc_id, "", `# Deal notes\n\nSee [the deal](${dealHref}).\n`);
      await work();
      const brokenFor = async (who: Person) =>
        (await ok<WikiLint>(person(who), "GET", "/api/wiki/lint")).broken_links.filter((b) => b.doc_id === dealNotes.doc_id).flatMap((b) => b.links);
      const livsBefore = await brokenFor("tbliv");
      expect(livsBefore).toEqual([{ href: `/doc/${deals.id}`, kind: "link", reason: "not_found" }]);
      expect(await brokenFor("tbdee")).toEqual([]);
      await ok(person("tbdee"), "POST", `/api/databases/${deals.id}/tables/${deals.table.table_id}/rows/delete`, { row_ids: [deals.rowIds[0]] });
      await work([deals.id]);
      expect(await brokenFor("tbliv")).toEqual(livsBefore);
      expect(await brokenFor("tbdee")).toEqual([{ href: dealHref, kind: "link", reason: "row_deleted", title: "Deals" }]);

      // A citation of the row now gone, or of a row of a database the caller cannot read, is refused.
      for (const [docId, rowId] of [
        [customers.id, globex!],
        [deals.id, deals.rowIds[0]!],
      ] as const) {
        const res = await call(agent(), "POST", `/api/docs/${notes.doc_id}/propose`, {
          action: "cited_edits",
          edits: [{ old_string: "Globex pays on time", new_string: "Globex pays late" }],
          citations: [{ n: 1, doc_id: docId, title: "x", table_id: t, row_id: rowId }],
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("citation_not_found");
      }
    });
  });
});
