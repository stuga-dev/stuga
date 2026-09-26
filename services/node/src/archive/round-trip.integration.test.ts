/**
 * A workspace exported and imported again, end to end, on real document and database actors and a
 * real Postgres: every block type, folders two deep, a database of two tables with views and 150
 * row pages, threaded comments and every document setting, made through the routes a person's
 * writes take. The export passes `stuga-node archive check` unzipped, and the new workspace reads
 * as the old one did, ids aside, and keeps its titles once its bodies flush. Needs
 * TEST_DATABASE_URL; skips without it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import { closeClients, createClient, getDoc, initSchema, listComments, provisionWorkspace, type Sql } from "@stuga/db";
import { DOC_STORE_VERSION, DocActor } from "@stuga/doc-actor";
import type { DatabaseSchema, RowFilterNode, TableSchema } from "@stuga/protocol/databases/types";
import { DOC_FLUSH_INTERVAL_MS } from "@stuga/protocol/domain/limits";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, fsBlobStore, type HostedNamespace } from "@stuga/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importWorkspace } from "../api/workspaces.js";
import { type AccountCtx, type Ctx, workspaceContextFor } from "../auth/context.js";
import { createNodeSettingsStore } from "../config/settings/node.js";
import { callDatabaseActor } from "../databases/gate.js";
import { openRowPages } from "../databases/row-pages.js";
import { seedBody } from "../documents/create.js";
import type { NodeEnv } from "../env.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import type { PathMatch } from "../http/router.js";
import { openZip } from "../lib/zip.js";
import { storeImage } from "../media/media.js";
import { createInternalApi } from "../platform/internal-api.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { runArchiveCommand } from "./check.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_round_trip_${process.pid}`;
const WS = "ws-round-trip";
/** A 1×1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const PAGES = 150;

let maintenance: LockSql;
let sql: Sql;
let dir: string;
let namespaces: HostedNamespace[];
let env: NodeEnv;
/** Every job the node queued: each flush's index job, and the audit rows. */
const jobs = { send: vi.fn(async (_m: IndexMessage) => {}) };

const liv = (): AccountCtx => ({ sql, surface: "web", alias: "u_liv", displayName: "Liv", isAgent: false, env });

async function inWorkspace(workspaceId: string): Promise<Ctx> {
  const ctx = await workspaceContextFor({ account: liv(), workspaces: null, readOnly: false }, workspaceId);
  if (!ctx) throw new Error(`u_liv is not a member of ${workspaceId}`);
  return ctx;
}

async function call<T = Record<string, unknown>>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const res = await routeWorkspaceRequest(ctx, req);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// ---- Reading a workspace back, ids turned into names -------------------------------------------

interface Snapshot {
  workspace: { name: string; agent_instructions: string };
  /** By folder path. */
  folders: Record<string, { agent_instructions: string }>;
  /** Documents and databases by folder path and title, row pages by `page:<table>#<row name>`. */
  docs: Record<string, Record<string, unknown>>;
  /** Each key's id, and each id's key. */
  keyOf: Map<string, string>;
  idOf: Map<string, string>;
  tables: Record<string, unknown>;
  rows: Record<string, unknown[]>;
  comments: Record<string, unknown[]>;
  markdown: Map<string, string>;
}

type Rows = Array<Record<string, unknown>>;

async function snapshot(ctx: Ctx): Promise<Snapshot> {
  const [workspace] = await sql<Array<{ name: string; agent_instructions: string }>>`
    SELECT name, agent_instructions FROM workspaces WHERE workspace_id = ${ctx.workspaceId}`;
  const folderRows = await sql<Array<{ folder_id: string; parent_id: string | null; title: string; agent_instructions: string }>>`
    SELECT folder_id, parent_id, title, agent_instructions FROM folders WHERE workspace_id = ${ctx.workspaceId}`;
  const within = (dir: string, title: string): string => (dir ? `${dir}/${title}` : title);
  const folderPath = (id: string | null): string => {
    if (id === null) return "";
    const folder = folderRows.find((f) => f.folder_id === id)!;
    return within(folderPath(folder.parent_id), folder.title);
  };
  const out: Snapshot = {
    workspace: workspace!,
    folders: {},
    docs: {},
    keyOf: new Map(),
    idOf: new Map(),
    tables: {},
    rows: {},
    comments: {},
    markdown: new Map(),
  };
  const name = (key: string, id: string): void => {
    out.idOf.set(key, id);
    out.keyOf.set(id, key);
  };
  for (const f of folderRows) {
    out.folders[folderPath(f.folder_id)] = { agent_instructions: f.agent_instructions };
    name(`folder:${folderPath(f.folder_id)}`, f.folder_id);
  }

  const docRows = await sql<
    Array<{
      doc_id: string;
      parent_id: string | null;
      doc_type: string;
      title: string;
      title_source: string;
      agent_mode: string;
      locked: boolean;
      search_hidden: boolean;
      agent_instructions: string;
      page_of: string | null;
      page_row: string | null;
    }>
  >`SELECT doc_id, parent_id, doc_type, title, title_source, agent_mode, locked, search_hidden, agent_instructions, page_of, page_row
    FROM docs WHERE workspace_id = ${ctx.workspaceId} AND trashed = FALSE`;
  const [database] = docRows.filter((d) => d.doc_type === "database");

  // The database first: its rows name the pages.
  const schema = await call<DatabaseSchema>(ctx, "GET", `/api/databases/${database!.doc_id}/schema`);
  const rowName = new Map<string, string>();
  const listed = new Map<string, Rows>();
  for (const table of schema.tables) {
    name(`table:${table.display}`, table.table_id);
    const nameColumn = table.columns.find((c) => c.display === "Name")!.column_id;
    const { rows } = await call<{ rows: Rows }>(ctx, "POST", `/api/databases/${database!.doc_id}/tables/${table.table_id}/rows/list`, { limit: 200 });
    listed.set(table.table_id, rows);
    for (const row of rows) {
      rowName.set(String(row._id), `${table.display}#${String(row[nameColumn])}`);
      name(`row:${table.display}#${String(row[nameColumn])}`, String(row._id));
    }
    for (const view of table.views) name(`view:${table.display}/${view.name}`, view.view_id);
  }
  const bodies = new Map<string, string>();
  for (const doc of docRows) {
    if (doc.doc_type === "prose") bodies.set(doc.doc_id, (await call<{ markdown: string }>(ctx, "GET", `/api/docs/${doc.doc_id}/markdown`)).markdown);
  }
  // A document by where it is and its title; two alike titles in one folder by their last line too.
  const placed = (doc: (typeof docRows)[number]) => within(folderPath(doc.parent_id), doc.title);
  for (const doc of docRows) {
    let key = doc.page_row === null ? placed(doc) : `page:${rowName.get(doc.page_row.slice(doc.page_row.indexOf(".") + 1))}`;
    if (doc.page_row === null && docRows.filter((d) => d.page_row === null && placed(d) === key).length > 1) key += ` · ${bodies.get(doc.doc_id)!.split("\n").pop()}`;
    name(key, doc.doc_id);
  }
  for (const doc of docRows) {
    const key = out.keyOf.get(doc.doc_id)!;
    out.docs[key] = {
      doc_type: doc.doc_type,
      title: doc.title,
      title_source: doc.title_source,
      agent_mode: doc.agent_mode,
      locked: doc.locked,
      search_hidden: doc.search_hidden,
      agent_instructions: doc.agent_instructions,
      page_of: doc.page_of === null ? null : out.keyOf.get(doc.page_of),
      parent: folderPath(doc.parent_id),
    };
    if (bodies.has(doc.doc_id)) out.markdown.set(key, bodies.get(doc.doc_id)!);
    const comments = await listComments(sql, doc.doc_id);
    const at = new Map(comments.map((c, i) => [Number(c.num), i]));
    out.comments[key] = comments.map((c) => ({
      parent: c.parent_num === null ? null : at.get(Number(c.parent_num)),
      author: c.author,
      body: c.body,
      quote: c.anchor_quote,
      resolved: c.resolved,
      anchored: c.anchor_start !== null,
      created_at: new Date(c.created_at).toISOString(),
    }));
  }

  // Tables, views and rows with every id as the name it stands for.
  for (const table of schema.tables) {
    const columnName = new Map(table.columns.map((c) => [c.column_id, c.display]));
    const ref = (id: string): string => columnName.get(id) ?? id;
    const filter = (node: RowFilterNode): unknown => {
      if ("and" in node) return { and: node.and.map(filter) };
      if ("or" in node) return { or: node.or.map(filter) };
      const value = node.column_id === "_id" ? rowName.get(String(node.value)) : node.value;
      return { column: ref(node.column_id), op: node.op, ...(node.value === undefined ? {} : { value }) };
    };
    out.tables[table.display] = {
      position: table.position,
      columns: [...table.columns].sort((a, b) => a.position - b.position).map((c) => ({ display: c.display, type: c.type, options: c.options, description: c.description })),
      views: table.views.map((v) => ({
        name: v.name,
        kind: v.kind,
        position: v.position,
        filter: v.filter === null ? null : filter(v.filter),
        sorts: v.sorts.map((s) => ({ column: ref(s.column_id), dir: s.dir })),
        group_by: v.group_by === null ? null : ref(v.group_by),
        hidden_columns: v.hidden_columns.map(ref),
        config: v.config,
      })),
    };
    out.rows[table.display] = listed.get(table.table_id)!.map((row) => {
      const cells: Record<string, unknown> = {};
      for (const column of table.columns) cells[column.display] = row[column.column_id];
      return { ...cells, page: typeof row._doc_id === "string" ? out.keyOf.get(row._doc_id) : null };
    });
  }
  return out;
}

/** The title each document's last flush gave it, by id. */
function flushedTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const [m] of jobs.send.mock.calls) if (m.kind === "index_doc" && m.title) titles.set(m.docId, m.title);
  return titles;
}

/**
 * Run out every flush interval and wait for each document with a body to flush: its alarm writes
 * the snapshot and queues the index job that names the document by its first line.
 */
async function flushBodies(workspaceIds: string[]): Promise<void> {
  const written: string[] = [];
  for (const { doc_id } of await sql<Array<{ doc_id: string }>>`
    SELECT doc_id FROM docs WHERE workspace_id IN ${sql(workspaceIds)} AND doc_type = 'prose' AND trashed = FALSE`) {
    const res = await env.docs.get(doc_id).fetch(`http://actor/markdown?docId=${encodeURIComponent(doc_id)}`);
    if (((await res.json()) as { markdown: string }).markdown !== "") written.push(doc_id);
  }
  await vi.advanceTimersByTimeAsync(DOC_FLUSH_INTERVAL_MS);
  await vi.waitFor(() => expect(written.filter((id) => !flushedTitles().has(id))).toEqual([]), { timeout: 20_000 });
}

/**
 * Each document titled by its first line takes the title its last flush gave, as the indexer
 * sets it; what it renamed, by id.
 */
async function indexTitles(workspaceId: string): Promise<Array<{ doc_id: string; from: string; to: string }>> {
  const flushed = flushedTitles();
  const renamed: Array<{ doc_id: string; from: string; to: string }> = [];
  for (const doc of await sql<Array<{ doc_id: string; title: string }>>`
    SELECT doc_id, title FROM docs WHERE workspace_id = ${workspaceId} AND title_source = 'heading'`) {
    const to = flushed.get(doc.doc_id);
    if (to === undefined || to === doc.title) continue;
    await sql`UPDATE docs SET title = ${to} WHERE doc_id = ${doc.doc_id}`;
    renamed.push({ doc_id: doc.doc_id, from: doc.title, to });
  }
  return renamed;
}

/**
 * A source body as the import should write it: every id as the new workspace's, a link to this
 * node relative when it leads to something exported and absolute when not, the mention as plain
 * text, and each image on the document that shows it.
 */
function expectedBody(markdown: string, from: Snapshot, to: Snapshot, docId: string): string {
  const ids = [...from.keyOf.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return markdown
    .replace(/\[@Liv\]\(mention:u_liv\)/g, "@Liv")
    .replace(/\[Contributing\]\(CONTRIBUTING\.md\)/g, "Contributing")
    .replace(/\]\((?:https:\/\/node\.test)?\/doc\/([^?)\s]+)/g, (_, id: string) => (from.keyOf.has(id) ? `](/doc/${id}` : `](https://node.test/doc/${id}`))
    .replace(/\/api\/docs\/[^/\s)]+\/media\//g, `/api/docs/${docId}/media/`)
    .replace(pattern, (id) => to.idOf.get(from.keyOf.get(id)!)!);
}

describe.skipIf(!URL)("a workspace exported and imported again", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    // The node's own client, which reads BIGINT as a number.
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    await sql`INSERT INTO users (alias, username, display_name) VALUES ('u_liv', 'liv', 'Liv')`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Liv's team", owner: "u_liv", defaultDocAccess: "workspace_edit" });

    dir = mkdtempSync(join(tmpdir(), "stuga-round-trip-"));
    const snapshots = fsBlobStore(join(dir, "snapshots"));
    const heartbeat = { request: Heartbeat.PING, response: Heartbeat.PONG };
    const internal = createInternalApi(async () => new Response("not in this test", { status: 503 }));
    const docs = createActorNamespace(DocActor, { snapshots, jobs, ai: () => ({}) as never, internal }, {
      name: "docs",
      heartbeat,
      dir: join(dir, "docs"),
      storeVersion: DOC_STORE_VERSION,
    });
    const databases = createActorNamespace(DatabaseActor, { snapshots, jobs }, {
      name: "databases",
      heartbeat,
      dir: join(dir, "databases"),
      storeVersion: DATABASE_STORE_VERSION,
    });
    namespaces = [docs, databases];
    const settings = await createNodeSettingsStore({ sql, dataDir: dir, publicOrigin: "https://node.test" });
    const media = fsBlobStore(join(dir, "media"));
    env = { sql, publicOrigin: "https://node.test", extraOrigins: [], docs, databases, snapshots, media, jobs, settings } as unknown as NodeEnv;
  });

  afterAll(async () => {
    vi.useRealTimers();
    for (const ns of namespaces ?? []) await ns.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    await closeClients();
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  it("imports what it exported: bodies, rows, views, pages, instructions, settings and comments", { timeout: 120_000 }, async () => {
    // A flush waits out its interval; fake time runs it out at once.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const ctx = await inWorkspace(WS);
    const post = <T = Record<string, unknown>>(path: string, body?: unknown) => call<T>(ctx, "POST", path, body);
    const patch = (path: string, body: unknown) => call(ctx, "PATCH", path, body);

    await patch(`/api/workspaces/${WS}`, { agent_instructions: "Answer in English.\nCite the document." });
    const plans = (await post<{ folder_id: string }>("/api/folders", { title: "Plans", agent_instructions: "Plans are drafts." })).folder_id;
    const q4 = (await post<{ folder_id: string }>("/api/folders", { title: "Q4", parent_id: plans, agent_instructions: "Q4 dates are firm." })).folder_id;
    const media = (await post<{ folder_id: string }>("/api/folders", { title: "Media" })).folder_id;
    const laws = (await post<{ folder_id: string }>("/api/folders", { title: "法律", agent_instructions: "引用原文。" })).folder_id;
    const { hash } = await storeImage(env.media, WS, PNG, "image/png");
    const image = (alt: string) => `![${alt}](/api/docs/x/media/${hash})`;
    const doc = async (title: string, parentId: string | null, markdown?: string) =>
      (await post<{ doc_id: string }>("/api/docs", { title, parent_id: parentId, ...(markdown === undefined ? {} : { markdown }) })).doc_id;

    const launch = (
      await post<{ doc_id: string }>("/api/docs", {
        title: "Launch",
        parent_id: q4,
        markdown: "# Launch\n\nShip in **October**.\n\n## Dates\n\nThe freeze starts on the first Monday.",
      })
    ).doc_id;

    // The database: two tables, every column type, views that name columns, rows and a page for each Task.
    const about = (text: string) => ({ description: text });
    const tracker = (
      await post<{ doc_id: string }>("/api/docs", {
        doc_type: "database",
        title: "Tracker",
        parent_id: plans,
        table: "Tasks",
        columns: [
          { name: "Name", type: "text", ...about("What the task is, in a few words.") },
          { name: "Estimate", type: "number", ...about("Days of work.") },
          { name: "Done", type: "checkbox", ...about("Shipped and checked.") },
          { name: "Due", type: "date", ...about("The last day it may land.") },
          { name: "Status", type: "single_select", choices: ["Open", "Doing", "Done"], ...about("Where the work stands.") },
        ],
      })
    ).doc_id;
    const tasks = (await call<DatabaseSchema>(ctx, "GET", `/api/databases/${tracker}/schema`)).tables[0]!.table_id;
    const people = (
      await post<{ table: TableSchema }>(`/api/databases/${tracker}/tables`, {
        display: "People",
        columns: [
          { name: "Name", type: "text" },
          { name: "Role", type: "single_select", choices: ["Lead", "Member"], ...about("Who decides.") },
          { name: "入职日期", type: "date" },
          { name: "Active", type: "checkbox" },
        ],
      })
    ).table.table_id;
    const statuses = ["Open", "Doing", "Done"];
    const taskRows = Array.from({ length: PAGES }, (_, i) => ({
      Name: `Task ${String(i + 1).padStart(3, "0")}`,
      Estimate: i % 7 === 0 ? null : (i % 8) + 0.5,
      Done: i % 3 === 0,
      Due: i % 5 === 0 ? null : `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      Status: i % 11 === 0 ? null : statuses[i % 3],
    }));
    const { row_ids: taskIds } = await post<{ row_ids: string[] }>(`/api/databases/${tracker}/tables/${tasks}/rows`, { rows: taskRows });
    const { row_ids: personIds } = await post<{ row_ids: string[] }>(`/api/databases/${tracker}/tables/${people}/rows`, {
      rows: [
        { Name: "Liv", Role: "Lead", 入职日期: "2025-02-03", Active: true },
        { Name: "Sample agent", Role: "Member", Active: false },
        { Name: "Reviewer", Role: null, 入职日期: "2026-01-15", Active: true },
      ],
    });
    const view = async (table: string, spec: Record<string, unknown>) =>
      (await post<{ view: { view_id: string } }>(`/api/databases/${tracker}/tables/${table}/views`, spec)).view.view_id;
    const openWork = await view(tasks, {
      name: "Open work",
      filter: {
        and: [
          { column_id: "Status", op: "ne", value: "Done" },
          { or: [{ column_id: "Estimate", op: "gt", value: 3 }, { column_id: "Due", op: "empty" }, { column_id: "Done", op: "eq", value: false }] },
          { column_id: "_doc_id", op: "not_empty" },
        ],
      },
      sorts: [
        { column_id: "Due", dir: "asc" },
        { column_id: "Estimate", dir: "desc" },
      ],
      hidden_columns: ["Estimate", "Done"],
      config: { density: "compact" },
    });
    const byStatus = await view(tasks, {
      name: "By status",
      group_by: "Status",
      sorts: [
        { column_id: "Name", dir: "asc" },
        { column_id: "_created_at", dir: "desc" },
      ],
    });
    await view(tasks, { name: "One task", filter: { column_id: "_id", op: "eq", value: taskIds[4] } });
    await view(people, { name: "Leads", filter: { column_id: "Role", op: "eq", value: "Lead" }, hidden_columns: ["入职日期"] });
    await view(people, { name: "按角色", group_by: "Role", sorts: [{ column_id: "入职日期", dir: "desc" }] });

    // One page as the table's page button opens it, the rest as a bulk import links them.
    const first = await post<{ doc_id: string }>(`/api/databases/${tracker}/tables/${tasks}/rows/${taskIds[0]}/page`);
    const trackerRow = (await getDoc(sql, tracker))!;
    const rest = await openRowPages(
      ctx,
      trackerRow,
      tasks,
      taskIds.slice(1).map((rowId, i) => ({ rowId, title: taskRows[i + 1]!.Name })),
    );
    if (rest.kind !== "ok") throw new Error(`row pages: ${rest.message}`);
    const pageIds = [first.doc_id, ...rest.doc_ids];
    await post(`/api/databases/${tracker}/tables/${people}/rows/${personIds[0]}/page`);
    expect(await seedBody(ctx, pageIds[0]!, "# Task 001\n\nWrite the plan, then [launch](/doc/" + launch + ").")).toBe(true);
    expect(await seedBody(ctx, pageIds[1]!, "# Task 002\n\n* Draft\n* Review")).toBe(true);

    const blocks = (
      await post<{ doc_id: string }>("/api/docs", {
        title: "Blocks",
        markdown: [
          "# Blocks",
          `A paragraph with **bold**, *italic*, ~~struck~~, \`code\` and [a link to Launch](/doc/${launch}).  \nA line after a hard break.`,
          "## Lists",
          "* One\n  * One and a half\n* Two",
          "1. First\n2. Second\n   1. Second, part one",
          "> A quote.\n>\n> Two paragraphs long.",
          "### Code",
          "```ts\nconst answer = 42;\n```",
          "```mermaid\ngraph TD\n  A[Plan] --> B[Ship]\n```",
          "````md\n```js\nconst fenced = true;\n```\n````",
          "1990\\. was a year; \\*this\\* is not emphasis, <b>nor this</b>, and [a link](https://example.com/a_(b)) keeps its parentheses.",
          '[Write to us](mailto:team@example.com), read [the guide](https://example.com/guide "The guide"), or [Contributing](CONTRIBUTING.md), a link kept from a Markdown file.',
          '![Remote](https://example.com/logo.png "Hosted elsewhere")',
          "中文段落，带标点。 فقرة عربية قصيرة. Emoji 🚀 and a zero\u200dwidth joiner.",
          `| Name | Logo | Notes |\n| --- | :---: | ---: |\n| Stuga | ${image("Logo")} | a \\| pipe |\n| Rows | | \`a\\|b\` and *two* |`,
          "A claim that needs a source.[^1] Another one.[^2]",
          `[^1]: [Launch — Dates](/doc/${launch}) "The freeze starts on the first Monday."`,
          "[^2]: A plain note.",
          "---",
          image("Chart"),
        ].join("\n\n"),
      })
    ).doc_id;
    const memo = await doc("Locked memo", null, "# Locked memo\n\nNothing here changes.");
    const notes = await doc("Notes", plans, "# Notes\n\nAgents may edit this at once.");
    // Names a file cannot take as they are: alike, alike but for case, reserved, unsafe, long, decomposed, and in other scripts.
    await doc("Minutes", plans, "# Minutes\n\nMarch.");
    await doc("Minutes", plans, "# Minutes\n\nApril.");
    await doc("minutes", plans, "# minutes\n\nMay.");
    await doc("Logo sheet", media, `# Logo sheet\n\n${image("Logo")}`);
    await doc("Plan: Q4/Q1?", q4, "# Plan: Q4/Q1?\n\nBoth quarters.");
    await doc("长标题".repeat(30), q4, `# ${"长标题".repeat(30)}\n\n很长。`);
    await doc("Cafe\u0301 notes", null, "# Cafe\u0301 notes\n\nDecomposed.");
    await doc("个人信息保护法", laws, "# 个人信息保护法\n\n## 第一章 总则\n\n第一条 为了保护个人信息权益，规范个人信息处理活动，制定本法。");
    await doc("قانون حماية البيانات الشخصية", laws, "# قانون حماية البيانات الشخصية\n\n## المادة 1\n\nيهدف هذا القانون إلى حماية البيانات الشخصية.");
    await doc("Empty", null);
    // Titled by a first line that is no heading, written after the title was set and not yet flushed into it.
    expect(await seedBody(ctx, await doc("Plain", null), "Plain first line, no heading.\n\n* A list")).toBe(true);
    expect(await seedBody(ctx, await doc("Checklist", plans), "* Buy milk\n* Eggs\n\nDone by Friday.")).toBe(true);
    const draft = await doc("Old draft", plans, "# Old draft\n\nGone.");
    await patch(`/api/docs/${draft}`, { trashed: true });
    const start = (
      await post<{ doc_id: string }>("/api/docs", {
        title: "Start here",
        markdown: [
          "# Start here",
          `Read [Blocks](/doc/${blocks}) first, then [the launch plan](https://node.test/doc/${launch}).`,
          `Browse [Plans](/?folder=${plans}) and [Q4](/?folder=${plans}/${q4}).`,
          `See [open work](/doc/${tracker}?table=${tasks}&view=${openWork}), [task 5](/doc/${tracker}?table=${tasks}&view=${byStatus}&row=${taskIds[4]}), ` +
            `[the people](/doc/${tracker}?table=${people}) and [the first page](/doc/${pageIds[0]}?row=${tracker}.${tasks}.${taskIds[0]}).`,
          "Ask [@Liv](mention:u_liv), or read [the guide](https://example.com/guide).",
          image("Chart"),
        ].join("\n\n"),
      })
    ).doc_id;
    await doc(
      "Retro",
      q4,
      [
        "# Retro",
        `Back to [Start here](/doc/${start}) and [the first page](/doc/${pageIds[0]}?row=${tracker}.${tasks}.${taskIds[0]}).`,
        `Ask [the lead](/doc/${tracker}?table=${people}&row=${personIds[0]}), see [Media](/?folder=${media}), not [the old draft](/doc/${draft}).`,
      ].join("\n\n"),
    );

    // Comments: a thread with a reply, a resolved one, and one each on a locked document, a page and the database.
    const comment = (doc: string, body: Record<string, unknown>) => post<{ num: number }>(`/api/docs/${doc}/comments`, body);
    const thread = await comment(blocks, { body: "Is this table final?", anchor_quote: "Stuga" });
    await comment(blocks, { body: "Yes, for now.", parent_num: thread.num });
    const done = await comment(blocks, { body: "Fix the quote.", anchor_quote: "A quote." });
    await patch(`/api/docs/${blocks}/comments/${done.num}`, { resolved: true });
    await comment(memo, { body: "Keep this frozen." });
    await comment(pageIds[0]!, { body: "Who owns this?", anchor_quote: "Write the plan" });
    await comment(tracker, { body: "Two tables are enough." });
    await sql`UPDATE comments SET created_at = '2026-03-01T09:30:00Z' WHERE doc_id = ${blocks} AND num = ${thread.num}`;

    // Settings last, as a person would set them once the writing is done.
    await patch(`/api/docs/${launch}/state`, { agent_instructions: "Keep the dates." });
    await patch(`/api/docs/${notes}/state`, { agent_mode: "auto", search_hidden: true, agent_instructions: "Short lines." });
    await patch(`/api/docs/${notes}`, { title: "Notes, renamed" });
    await patch(`/api/docs/${memo}/state`, { locked: true });
    await patch(`/api/docs/${pageIds[1]}/state`, { locked: true });
    await patch(`/api/docs/${tracker}/state`, { agent_instructions: "One row per task.", agent_mode: "auto", locked: true });

    // Export, then check the archive unzipped, as a sample is checked before it is published.
    let t = performance.now();
    const res = await routeWorkspaceRequest(ctx, new Request(`https://node.test/api/workspaces/${WS}/export`));
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const exportMs = performance.now() - t;
    const archive = openZip(bytes);
    const unzipped = join(dir, "archive");
    for (const name of archive.files.keys()) {
      mkdirSync(dirname(join(unzipped, name)), { recursive: true });
      writeFileSync(join(unzipped, name), await archive.read(name));
    }
    let report = "";
    expect(await runArchiveCommand(["check", unzipped, "--json"], (text) => void (report += text))).toBe(0);
    const check = JSON.parse(report) as { ok: boolean; counts: Record<string, number> };
    expect(check).toMatchObject({ ok: true, counts: { rows: PAGES + 3, images: 1 } });

    // Import it as a new workspace, through the route the web app calls.
    t = performance.now();
    const imported = await importWorkspace({
      ctx: liv(),
      req: new Request("https://node.test/api/workspaces/import", { method: "POST", body: bytes }),
      url: new globalThis.URL("https://node.test/api/workspaces/import"),
      match: [] as unknown as PathMatch,
    });
    const importMs = performance.now() - t;
    expect(imported.status).toBe(201);
    const created = (await imported.json()) as { workspace_id: string; name: string };
    expect(created.name).toBe("Liv's team");

    // Once flushed and indexed, each source document is named by its first line; the imported ones are named so already.
    await flushBodies([WS, created.workspace_id]);
    vi.useRealTimers();
    console.info(`round trip: export ${Math.round(exportMs)} ms (${bytes.byteLength} bytes), import ${Math.round(importMs)} ms`);
    expect((await indexTitles(WS)).map((r) => r.to).sort()).toEqual(["Buy milk", "Plain first line, no heading."]);
    expect(await indexTitles(created.workspace_id)).toEqual([]);

    const before = await snapshot(ctx);
    const target = await inWorkspace(created.workspace_id);
    const after = await snapshot(target);

    expect(after.workspace).toEqual(before.workspace);
    expect(after.folders).toEqual(before.folders);
    expect(Object.keys(after.docs).sort()).toEqual(Object.keys(before.docs).sort());
    expect(Object.keys(before.docs).filter((k) => k.startsWith("page:"))).toHaveLength(PAGES + 1);
    expect(check.counts).toMatchObject({ items: Object.keys(before.folders).length + Object.keys(before.docs).length - PAGES - 1, bodies: before.markdown.size });
    expect(after.docs).toEqual(before.docs);
    expect(after.tables).toEqual(before.tables);
    expect(after.rows).toEqual(before.rows);

    for (const [key, markdown] of before.markdown) {
      expect({ key, markdown: after.markdown.get(key) }).toEqual({ key, markdown: expectedBody(markdown, before, after, after.idOf.get(key)!) });
    }
    expect(before.markdown.get("Start here")).toContain("[@Liv](mention:u_liv)");
    expect(after.markdown.get("Start here")).toContain("Ask @Liv, or read");

    // Comments keep their threads, times and resolution; the author is a name, never an account.
    for (const [key, comments] of Object.entries(before.comments)) {
      const expected = comments.map((c) => ({ ...(c as object), author: "imported:Liv", anchored: false }));
      expect({ key, comments: after.comments[key] }).toEqual({ key, comments: expected });
    }
    expect(after.comments["Blocks"]![0]).toMatchObject({ created_at: "2026-03-01T09:30:00.000Z", quote: "Stuga" });

    // Both ends audited.
    const prose = Object.values(before.docs).filter((d) => d.doc_type === "prose").length;
    const audits = jobs.send.mock.calls.flatMap(([m]) => (m.kind === "audit" && /^workspace\.(export|import)$/.test(m.action) ? [m] : []));
    expect(audits).toMatchObject([
      { action: "workspace.export", workspaceId: WS, detail: { docs: prose, databases: 1, bytes: bytes.byteLength } },
      {
        action: "workspace.import",
        workspaceId: created.workspace_id,
        detail: {
          folders: Object.keys(before.folders).length,
          docs: prose - PAGES - 1,
          databases: 1,
          pages: PAGES + 1,
          rows: PAGES + 3,
          images: 1,
          comments: Object.values(before.comments).flat().length,
        },
      },
    ]);

    // One image, stored once for the new workspace.
    expect((await env.media.list({ prefix: `media/${created.workspace_id}/` })).objects.map((o) => o.key)).toEqual([`media/${created.workspace_id}/${hash}`]);

    // Each table's pages were linked in one mutation, well inside the actor's 120 a minute.
    const trackerId = after.idOf.get("Plans/Tracker")!;
    const opsRes = await callDatabaseActor(target, trackerId, "ops?limit=500", null, "GET");
    const { ops } = (await opsRes.json()) as { ops: Array<{ kind: string; summary: string }> };
    expect(ops.filter((op) => op.kind === "rows.link_pages").map((op) => op.summary).sort()).toEqual([
      'Linked 1 page to rows of "People"',
      `Linked ${PAGES} pages to rows of "Tasks"`,
    ]);
    expect(ops.filter((op) => op.kind === "rows.link_page")).toHaveLength(0);
    expect(ops.length).toBeLessThan(20);
  });
});
