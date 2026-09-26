/**
 * Every sample in a checkout of stuga-dev/samples, built as a release publishes it, served as a
 * release list is, and created through POST /api/workspaces on real document and database
 * actors and a real Postgres: the rows land, Sample agent's steps wait in review for the person
 * who created it, its comment mentions them, and the start document opens first. Needs
 * TEST_DATABASE_URL and SAMPLES_DIR, the checkout; skips without either.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import { closeClients, createClient, getDoc, initSchema, listComments, type Sql } from "@stuga/db";
import { DOC_STORE_VERSION, DocActor } from "@stuga/doc-actor";
import type { DatabaseRunSummary, DatabaseSchema } from "@stuga/protocol/databases/types";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, fsBlobStore, type HostedNamespace } from "@stuga/runtime";
import { MemoryJobQueue } from "@stuga/runtime/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, listWorkspaceSamples } from "../api/workspaces.js";
import type { AccountCtx } from "../auth/context.js";
import { createNodeSettingsStore } from "../config/settings/node.js";
import type { NodeEnv } from "../env.js";
import { createInternalApi } from "../platform/internal-api.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { readArchive } from "./import.js";

const URL = process.env.TEST_DATABASE_URL;
const SAMPLES_DIR = process.env.SAMPLES_DIR;
const BUILD = SAMPLES_DIR ? join(SAMPLES_DIR, "scripts", "build.mjs") : "";
const DB = `stuga_samples_${process.pid}`;
const TAG = "v2026.09.25";

interface Listed {
  id: string;
  file: string;
  name: string;
}

let maintenance: LockSql;
let sql: Sql;
let dir: string;
let dist: string;
let server: Server;
let namespaces: HostedNamespace[];
let env: NodeEnv;
const jobs = new MemoryJobQueue<IndexMessage>();

const liv = (): AccountCtx => ({ sql, surface: "web", alias: "u_liv", displayName: "Liv", isAgent: false, env });

async function actor<T>(ns: HostedNamespace, id: string, path: string, key: "docId" | "dbId"): Promise<T> {
  return (await (await ns.get(id).fetch(`http://actor/${path}?${key}=${encodeURIComponent(id)}`)).json()) as T;
}

describe.skipIf(!URL || !BUILD || !existsSync(BUILD))("creating a workspace from each published sample", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-samples-"));
    dist = join(dir, "dist");
    // As the samples release workflow builds them: each archive and the index. The script's own
    // path is not argv[1], which would make importing it run its command line.
    const script = "const [, root, tag, out, build] = process.argv; await (await import(build)).build(root, tag, out);";
    execFileSync(process.execPath, ["--input-type=module", "-e", script, SAMPLES_DIR!, TAG, dist, BUILD]);
    // The layout of a GitHub release list, which SAMPLES_URL points at.
    const assets = `/releases/download/${TAG}/`;
    server = createServer((req, res) => {
      const path = req.url ?? "";
      const file = path === "/releases/latest/download/index.json" ? "index.json" : path.startsWith(assets) ? path.slice(assets.length) : null;
      if (!file || file.includes("/") || !existsSync(join(dist, file))) return void res.writeHead(404).end();
      res.writeHead(200).end(readFileSync(join(dist, file)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const samplesUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;

    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    await sql`INSERT INTO users (alias, username, display_name) VALUES ('u_liv', 'liv', 'Liv')`;

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
    env = { sql, publicOrigin: "https://node.test", extraOrigins: [], samplesUrl, docs, databases, snapshots, media, jobs, settings } as unknown as NodeEnv;
  }, 120_000);

  afterAll(async () => {
    for (const ns of namespaces ?? []) await ns.close();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    if (dir) rmSync(dir, { recursive: true, force: true });
    await closeClients();
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  it("offers every sample, in the index's order", async () => {
    const index = JSON.parse(readFileSync(join(dist, "index.json"), "utf8")) as { samples: Listed[] };
    const req = new Request("https://node.test/api/workspace-samples");
    const res = await listWorkspaceSamples({ ctx: liv(), req, url: new globalThis.URL(req.url), match: [] });
    const { samples } = (await res.json()) as { samples: Array<{ id: string; name: string }> };
    expect(samples.map((s) => [s.id, s.name])).toEqual(index.samples.map((s) => [s.id, s.name]));
    expect(samples).toHaveLength(4);
  });

  it("creates each sample with its rows, Sample agent's proposals and comment for the person, and the start document", { timeout: 300_000 }, async () => {
    const index = JSON.parse(readFileSync(join(dist, "index.json"), "utf8")) as { samples: Listed[] };
    for (const listed of index.samples) {
      const contents = await readArchive(readFileSync(join(dist, listed.file)), { maxImageBytes: 10 * 1024 * 1024 });
      const { manifest } = contents;
      const steps = manifest.sample?.steps ?? [];
      const sent = jobs.sent.length;

      const req = new Request("https://node.test/api/workspaces", { method: "POST", body: JSON.stringify({ sample: listed.id }) });
      const res = await createWorkspace({ ctx: liv(), req, url: new globalThis.URL(req.url), match: [] });
      const body = (await res.json()) as { workspace_id: string; name: string; start_doc_id?: string; error?: string };
      expect(res.status, `${listed.id}: ${body.error}`).toBe(201);
      expect(body.name).toBe(listed.name);
      const docs = await sql<Array<{ doc_id: string; title: string; doc_type: string }>>`
        SELECT doc_id, title, doc_type FROM docs WHERE workspace_id = ${body.workspace_id}`;

      // The start document, by its title, is the one the answer names.
      const start = manifest.items.find((i) => i.kind === "doc" && i.path === manifest.start)!;
      expect(docs.find((d) => d.doc_id === body.start_doc_id)?.title, listed.id).toBe(start.kind === "doc" ? start.title : null);

      // Every table holds its rows file's rows.
      for (const db of docs.filter((d) => d.doc_type === "database")) {
        const item = manifest.items.find((i) => i.kind === "database" && i.title === db.title)!;
        const schema = await actor<DatabaseSchema>(env.databases as HostedNamespace, db.doc_id, "schema", "dbId");
        for (const table of item.kind === "database" ? item.tables : []) {
          const expected = (await contents.rows(table.file)).length;
          expect(schema.tables.find((t) => t.display === table.name)?.row_count, `${listed.id}: ${table.file}`).toBe(expected);
        }
      }

      // Each edit step waits in one run of Sample agent's on its document; each row step as one pending op.
      const docIdOf = (title: string) => docs.find((d) => d.title === title)!.doc_id;
      const titleOf = (path: string) => contents.index.bodies.get(path)!.item.title;
      for (const doc of new Set(steps.flatMap((s) => (s.kind === "edit" ? [s.doc] : [])))) {
        const { runs } = await actor<{ runs: AgentRunSummary[] }>(env.docs as HostedNamespace, docIdOf(titleOf(doc)), "runs", "docId");
        expect(runs.map((r) => [r.agent_alias, r.agent, r.reviewer, r.status]), `${listed.id}: ${doc}`).toEqual([["agent-sample", "Sample agent", "u_liv", "open"]]);
        expect(runs[0]!.hunks.length).toBeGreaterThan(0);
        expect(runs[0]!.hunks.every((h) => h.status === "pending")).toBe(true);
      }
      for (const database of new Set(steps.flatMap((s) => (s.kind === "row" ? [s.database] : [])))) {
        const item = contents.index.databases.get(database)!;
        const { runs } = await actor<{ runs: DatabaseRunSummary[] }>(env.databases as HostedNamespace, docIdOf(item.title), "runs", "dbId");
        const rowSteps = steps.filter((s) => s.kind === "row" && s.database === database).length;
        expect(runs.map((r) => [r.agent_alias, r.agent, r.reviewer]), `${listed.id}: ${database}`).toEqual([["agent-sample", "Sample agent", "u_liv"]]);
        expect(runs[0]!.ops.map((o) => [o.kind, o.status])).toEqual(Array.from({ length: rowSteps }, () => ["rows.update", "pending"]));
      }

      // Each comment step is Sample agent's, placed by its quote, and mentions the person, who is told.
      for (const step of steps) {
        if (step.kind !== "comment") continue;
        const docId = docIdOf(titleOf(step.doc));
        const comments = (await listComments(sql, docId)).filter((c) => c.author === "agent-sample");
        expect(comments.map((c) => [c.body, c.anchor_quote]), `${listed.id}: ${step.doc}`).toEqual([[step.body.replaceAll("{{me}}", "@liv"), step.quote ?? null]]);
        expect(jobs.sent.slice(sent)).toContainEqual(expect.objectContaining({ kind: "notify", recipient: "u_liv", eventType: "MENTIONED_IN_COMMENT", docId }));
      }
      expect(steps.some((s) => s.kind === "comment"), listed.id).toBe(true);

      // Settings land after the steps: a document the sample locks is locked, its proposals still waiting.
      for (const item of manifest.items) {
        if (item.kind === "folder" || !item.locked) continue;
        expect((await getDoc(sql, docIdOf(item.title)))?.locked, `${listed.id}: ${item.path}`).toBe(true);
      }
    }
  });
});
