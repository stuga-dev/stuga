/**
 * An archive imported end to end: the real routes, the document and database actors on disk and a
 * real Postgres, then the workspace purged; and one a stopped node left, deleted when it starts.
 * Needs TEST_DATABASE_URL; skips without it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import { DOC_STORE_VERSION, DocActor, type DocActorEnv } from "@stuga/doc-actor";
import { type DocRow, finishWorkspaceImport, initSchema, listComments, listWorkspacesForUser, provisionWorkspace } from "@stuga/db";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, type HostedNamespace } from "@stuga/runtime";
import { MemoryBlobStore, MemoryJobQueue } from "@stuga/runtime/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { purgeUnfinishedImports, purgeWorkspace } from "../api/workspaces.js";
import { type AccountCtx, workspaceContextFor } from "../auth/context.js";
import type { NodeEnv } from "../env.js";
import { DEFAULT_MAX_BODY_BYTES } from "../media/media.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { workspaceImportClient } from "./client.js";
import { importArchive, importWorkspaceArchive, readArchive } from "./import.js";
import { IMAGE, LIMITS, build, sha256, PNG } from "./testing/fixture.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_import_${process.pid}`;
const WS = "ws-import";

let maintenance: LockSql;
let sql: LockSql;
let dir: string;
let docs: HostedNamespace;
let databases: HostedNamespace;
let jobs: MemoryJobQueue<IndexMessage>;
let env: NodeEnv;

async function actor<T>(ns: HostedNamespace, id: string, path: string, key: "docId" | "dbId", body?: unknown): Promise<T> {
  const url = `http://actor/${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(id)}`;
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return (await (await ns.get(id).fetch(url, init)).json()) as T;
}

describe.skipIf(!URL)("importing an archive into a new workspace", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = sessionConnection(withDatabase(URL!, DB));
    await initSchema(sql as never);
    dir = mkdtempSync(join(tmpdir(), "stuga-import-"));
    const snapshots = new MemoryBlobStore();
    jobs = new MemoryJobQueue<IndexMessage>();
    const heartbeat = { request: Heartbeat.PING, response: Heartbeat.PONG };
    const docEnv = { snapshots, jobs, ai: () => ({}), internal: { fetch: async () => new Response(null, { status: 503 }) } } as unknown as DocActorEnv;
    docs = createActorNamespace(DocActor, docEnv, { name: "docs", heartbeat, dir: join(dir, "docs"), storeVersion: DOC_STORE_VERSION });
    databases = createActorNamespace(DatabaseActor, { snapshots, jobs }, { name: "databases", heartbeat, dir: join(dir, "databases"), storeVersion: DATABASE_STORE_VERSION });
    env = {
      sql,
      docs,
      databases,
      snapshots,
      media: new MemoryBlobStore(),
      jobs,
      settings: { current: () => ({ databaseOpsKeep: 500, maxBodyBytes: DEFAULT_MAX_BODY_BYTES }) },
    } as unknown as NodeEnv;
  });

  afterAll(async () => {
    await docs?.close();
    await databases?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  it("lands every item where the archive puts it, through the same routes a person's writes take, and purges clean", async () => {
    await provisionWorkspace(sql as never, { workspaceId: WS, name: "Privacy laws", owner: "u_liv", defaultDocAccess: "workspace_view" });
    const account = { sql, surface: "web", alias: "u_liv", displayName: "Liv", isAgent: false, env } as unknown as AccountCtx;
    const out = await importWorkspaceArchive(account, WS, await readArchive(build(), LIMITS));
    // Released once the import was done with each: every body was saved as it was written, so no actor waits on an alarm.
    expect(docs.resident()).toEqual([]);
    expect(databases.resident()).toEqual([]);

    const [workspace] = await sql<Array<{ agent_instructions: string }>>`SELECT agent_instructions FROM workspaces WHERE workspace_id = ${WS}`;
    expect(workspace!.agent_instructions).toBe("Answer with citations.");
    const folders = await sql<Array<{ folder_id: string; title: string; agent_instructions: string; owner: string }>>`
      SELECT folder_id, title, agent_instructions, owner FROM folders WHERE workspace_id = ${WS}`;
    expect(folders).toEqual([{ folder_id: out.ids.folders.get("Laws"), title: "Laws", agent_instructions: "Quote the official text.", owner: "user:u_liv" }]);

    const rows = await sql<DocRow[]>`SELECT * FROM docs WHERE workspace_id = ${WS}`;
    const doc = (path: string): DocRow => rows.find((r) => r.doc_id === out.ids.docs.get(path))!;
    const startId = out.ids.docs.get("Start here.md")!;
    const gdpr = doc("Laws/GDPR.md");
    const page = doc("Obligations/pages/gdpr-breach.md");
    const db = out.ids.databases.get("Obligations")!;
    const dbRow = rows.find((r) => r.doc_id === db.docId)!;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.owner === "user:u_liv" && !r.acl_writers.includes(`org:${WS}`))).toBe(true);
    expect(gdpr).toMatchObject({ parent_id: folders[0]!.folder_id, title: "Regulation (EU) 2016/679", title_source: "user", locked: true });
    expect(gdpr).toMatchObject({ agent_mode: "auto", search_hidden: true, agent_instructions: "Quote articles." });
    expect(page).toMatchObject({ page_of: db.docId, locked: false, agent_mode: "review" });
    expect(dbRow).toMatchObject({ doc_type: "database", title: "Obligations", locked: true, agent_instructions: "One row per law and topic." });
    expect(out.startDocId).toBe(startId);
    // Each body a version of its own, by the person importing.
    const versions = jobs.sent.flatMap((m) => (m.kind === "index_doc" && m.recordVersion ? [[m.docId, m.snapshotSeq, m.versionAuthors]] : []));
    expect(versions).toEqual([
      [gdpr.doc_id, 1, ["u_liv"]],
      [page.doc_id, 1, ["u_liv"]],
      [startId, 1, ["u_liv"]],
    ]);

    // Bodies as the actor holds them: links point at the node, images at the workspace's copy, the mention is text.
    const table = db.tables.get("Main")!;
    const start = await actor<{ markdown: string }>(docs, startId, "markdown", "docId");
    expect(start.markdown).toContain(`[breaches](/doc/${db.docId}?table=${table.tableId}&view=${table.views.get("Breach")})`);
    expect(start.markdown).toContain(`[its page](/doc/${page.doc_id}?row=${db.docId}.${table.tableId}.${table.rows.get("gdpr-breach")})`);
    expect(start.markdown).toContain("Ask @Liv or see [the site](https://example.com/a).");
    expect(start.markdown).toContain(`![Chart](/api/docs/${startId}/media/${sha256(PNG)})`);
    expect(await env.media.head(`media/${WS}/${IMAGE.slice("media/".length, -".png".length)}`)).not.toBeNull();

    const schema = await actor<{ tables: Array<{ table_id: string; display: string; columns: Array<{ display: string }>; views: Array<{ name: string; filter: unknown }> }> }>(
      databases,
      db.docId,
      "schema",
      "dbId",
    );
    expect(schema.tables.map((t) => [t.display, t.columns.map((c) => c.display), t.views.map((v) => v.name)])).toEqual([
      ["Main", ["Law", "Topic", "Hours", "Checked", "Due"], ["Breach", "One row"]],
      ["Sources", ["URL"], []],
    ]);
    expect(schema.tables[0]!.views[1]!.filter).toEqual({ column_id: "_id", op: "eq", value: table.rows.get("gdpr-breach") });
    const listed = await actor<{ rows: Array<Record<string, unknown>> }>(databases, db.docId, "rows/list", "dbId", { table_id: table.tableId });
    expect(listed.rows.map((r) => [r[table.columns.get("Law")!], r[table.columns.get("Checked")!], r._doc_id])).toEqual([
      ["GDPR", 1, page.doc_id],
      ["PIPL", 0, null],
    ]);

    const comments = await listComments(sql as never, gdpr.doc_id);
    // BIGINT, which this bare connection reads as text.
    const num = (n: unknown) => (n === null ? null : Number(n));
    expect(comments.map((c) => [num(c.num), num(c.parent_num), c.author, c.anchor_quote, c.resolved])).toEqual([
      [1, null, "imported:Liv", "the start", true],
      [2, 1, "imported:Liv", null, false],
    ]);
    expect(new Date(comments[0]!.created_at).toISOString()).toBe("2026-03-01T09:30:00.000Z");

    expect(await purgeWorkspace(env, WS)).toEqual({ docs: 4 });
    expect(await sql`SELECT 1 FROM docs WHERE workspace_id = ${WS}`).toHaveLength(0);
    expect((await env.media.list({ prefix: `media/${WS}/` })).objects).toEqual([]);
  });

  it("lists a workspace a stopped node was importing into nowhere, and deletes it when the node starts again", async () => {
    const account = { sql, surface: "web", alias: "u_liv", displayName: "Liv", isAgent: false, env } as unknown as AccountCtx;
    const contents = await readArchive(build(), LIMITS);
    // Finished before the node stopped: it stays.
    await provisionWorkspace(sql as never, { workspaceId: "ws-finished", name: "Finished", owner: "u_liv", importing: true });
    await importWorkspaceArchive(account, "ws-finished", contents);
    expect(await finishWorkspaceImport(sql as never, "ws-finished")).toBe(true);

    // The node stops after the first body: the route never hears of it, so nothing deletes the workspace.
    await provisionWorkspace(sql as never, { workspaceId: "ws-stopped", name: "Stopped", owner: "u_liv", importing: true });
    const client = workspaceImportClient((await workspaceContextFor({ account, workspaces: null, readOnly: false }, "ws-stopped"))!);
    let bodies = 0;
    const stopping = {
      ...client,
      seedBody: async (docId: string, markdown: string) => {
        if (++bodies > 1) throw new Error("the node stopped");
        await client.seedBody(docId, markdown);
      },
    };
    await expect(importArchive(stopping, contents)).rejects.toThrow("the node stopped");
    const left = await sql<Array<{ doc_id: string; doc_type: "prose" | "database" }>>`SELECT doc_id, doc_type FROM docs WHERE workspace_id = 'ws-stopped'`;
    expect(left.length).toBeGreaterThan(0);
    expect((await listWorkspacesForUser(sql as never, "u_liv")).map((w) => w.workspace_id)).toEqual(["ws-finished"]);

    // The next start.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await purgeUnfinishedImports(env);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\[node\] deleting workspace ws-stopped \("Stopped"\): its import, started .+, stopped when the node did$/));
    info.mockRestore();
    expect(await sql`SELECT workspace_id FROM workspaces WHERE workspace_id IN ('ws-finished', 'ws-stopped')`).toEqual([{ workspace_id: "ws-finished" }]);
    expect(await sql`SELECT 1 FROM docs WHERE workspace_id = 'ws-stopped'`).toHaveLength(0);
    // Each document's actor went with it.
    const seeded = left.find((d) => d.doc_type === "prose")!;
    expect(await actor(docs, seeded.doc_id, "markdown", "docId")).toEqual({ error: "document deleted" });

    await purgeUnfinishedImports(env);
    expect(await sql`SELECT 1 FROM workspaces WHERE workspace_id = 'ws-finished'`).toHaveLength(1);
    await purgeWorkspace(env, "ws-finished");
  });
});
