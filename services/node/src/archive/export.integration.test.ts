/**
 * Workspace export end to end: a workspace made through the REST routes, with real document and
 * database actors and a real Postgres, exported through its route and held to the archive check.
 * Needs TEST_DATABASE_URL; skips without it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import { closeClients, createClient, initSchema, provisionWorkspace, type Sql } from "@stuga/db";
import { DOC_STORE_VERSION, DocActor } from "@stuga/doc-actor";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, fsBlobStore, type HostedNamespace } from "@stuga/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../auth/context.js";
import { createNodeSettingsStore } from "../config/settings/node.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { openZip } from "../lib/zip.js";
import { storeImage } from "../media/media.js";
import { createInternalApi } from "../platform/internal-api.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { checkArchive } from "./check.js";
import { parseManifest, parseTableRows, type ArchiveDatabase, type ArchiveDoc, type ArchiveManifest } from "./format.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_export_${process.pid}`;
const WS = "ws-export";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

let maintenance: LockSql;
let sql: Sql;
let dir: string;
let namespaces: HostedNamespace[];
let env: Record<string, unknown>;
const jobs: Array<Record<string, unknown>> = [];

function liv(): Ctx {
  return {
    sql,
    surface: "web",
    alias: "u_liv",
    displayName: "Liv",
    isAgent: false,
    principals: ["user:u_liv", `org:${WS}`],
    workspaceId: WS,
    role: "owner",
    env,
  } as unknown as Ctx;
}

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const res = await routeWorkspaceRequest(liv(), req);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

describe.skipIf(!URL)("workspace export with real actors", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    // The node's own client, which reads BIGINT as a number.
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    await sql`INSERT INTO users (alias, username, display_name) VALUES ('u_liv', 'liv', 'Liv')`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Liv's team", owner: "u_liv", defaultDocAccess: "workspace_edit" });

    dir = mkdtempSync(join(tmpdir(), "stuga-export-"));
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
    env = { sql, publicOrigin: "https://node.test", extraOrigins: [], docs, databases, snapshots, media, jobs: queue, settings };
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

  it("writes an archive the check passes, with rows, views, a row page, an image and a comment", async () => {
    const folder = await call<{ folder_id: string }>("POST", "/api/folders", { title: "Plans", agent_instructions: "Plans are drafts." });
    const { hash } = await storeImage(env.media as never, WS, PNG, "image/png");
    const plan = await call<{ doc_id: string }>("POST", "/api/docs", {
      title: "Plan",
      parent_id: folder.folder_id,
      markdown: `# Plan\n\nShip in **October**.\n\n![Chart](/api/docs/x/media/${hash})`,
    });
    const db = await call<{ doc_id: string }>("POST", "/api/docs", {
      doc_type: "database",
      title: "Tasks",
      parent_id: folder.folder_id,
      columns: [
        { name: "Name", type: "text" },
        { name: "Status", type: "single_select", choices: ["Open", "Done"] },
        { name: "Done", type: "checkbox" },
      ],
    });
    const schema = await call<{ tables: Array<{ table_id: string }> }>("GET", `/api/databases/${db.doc_id}/schema`);
    const table = schema.tables[0]!.table_id;
    const { row_ids } = await call<{ row_ids: string[] }>("POST", `/api/databases/${db.doc_id}/tables/${table}/rows`, {
      rows: [
        { Name: "Write", Status: "Open", Done: false },
        { Name: "Ship", Status: "Done", Done: true },
      ],
    });
    const { view } = await call<{ view: { view_id: string } }>("POST", `/api/databases/${db.doc_id}/tables/${table}/views`, {
      name: "Open",
      filter: { column_id: "Status", op: "eq", value: "Open" },
      sorts: [{ column_id: "Name", dir: "asc" }],
    });
    const page = await call<{ doc_id: string }>("POST", `/api/databases/${db.doc_id}/tables/${table}/rows/${row_ids[0]}/page`);
    await call("POST", "/api/docs", {
      title: "Start here",
      markdown: `# Start here\n\nRead [the plan](/doc/${plan.doc_id}), then [the open tasks](/doc/${db.doc_id}?table=${table}&view=${view.view_id}).`,
    });
    await call("POST", `/api/docs/${plan.doc_id}/comments`, { body: "Is this final?", anchor_quote: "October" });

    const res = await routeWorkspaceRequest(liv(), new Request(`https://node.test/api/workspaces/${WS}/export`));
    expect(res.status).toBe(200);
    const archive = openZip(new Uint8Array(await res.arrayBuffer()));
    // Released once read; a database keeps no alarm, so it is closed already.
    expect(namespaces[1]!.resident()).toEqual([]);
    const check = await checkArchive({
      sizes: new Map([...archive.files].map(([name, info]) => [name, info.size])),
      read: (name) => archive.read(name),
      others: new Map(),
    });
    expect(check.issues).toEqual([]);

    const text = async (name: string) => new TextDecoder().decode(await archive.read(name));
    const manifest: ArchiveManifest = parseManifest(JSON.parse(await text("stuga.json")));
    expect(manifest.items.map((i) => `${i.kind} ${i.path}`)).toEqual([
      "folder Plans",
      "doc Plans/Plan.md",
      "database Plans/Tasks",
      "doc Start here.md",
    ]);
    expect(await text("Start here.md")).toBe(
      `# Start here\n\nRead [the plan](Plans/Plan.md), then [the open tasks](Plans/Tasks#table=${encodeURIComponent("Tasks")}&view=Open).\n`,
    );
    expect(await text("Plans/Plan.md")).toContain("![Chart](../media/");
    const plans = manifest.items.find((i) => i.path === "Plans/Plan.md") as ArchiveDoc;
    expect(plans.comments).toMatchObject([{ num: 1, parent: null, author_name: "Liv", quote: "October", body: "Is this final?", resolved: false }]);

    const tasks = manifest.items.find((i) => i.path === "Plans/Tasks") as ArchiveDatabase;
    const [only] = tasks.tables;
    expect(only!.views).toMatchObject([{ name: "Open", filter: { column: "Status", op: "eq", value: "Open" }, sorts: [{ column: "Name", dir: "asc" }] }]);
    expect(only!.pages).toMatchObject([{ row: row_ids[0], file: `Plans/Tasks/pages/${row_ids[0]}.md`, title: "Write" }]);
    const rows = parseTableRows(await text(only!.file), only!);
    expect(rows.map((r) => ({ ...r.values }))).toEqual([
      { Name: "Write", Status: "Open", Done: 0 },
      { Name: "Ship", Status: "Done", Done: 1 },
    ]);
    expect(page.doc_id).toBeTruthy();
    expect(jobs.filter((m) => m.kind === "audit" && m.action === "workspace.export")).toHaveLength(1);
  });
});
