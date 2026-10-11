/**
 * The checked connection end to end against a real Postgres: an agent's upload_from_url through
 * /mcp, and a webhook delivery through the job queue, each aimed at a server on loopback that must
 * never see a connection. Needs TEST_DATABASE_URL; skips without it.
 */
import { createDoc, initSchema, insertWebhook, pgJobQueue, startJobWorker } from "@stuga/db";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { MemoryBlobStore } from "@stuga/runtime/testing";
import type { LookupOptions } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobsDb } from "../jobs/db.js";
import type { JobsEnv } from "../jobs/deps.js";
import { handleJobBatch } from "../jobs/worker.js";
import { DEFAULT_MAX_BODY_BYTES } from "../media/media.js";
import { callToolAs, callerFor } from "../mcp/testing/call.js";
import { agentCtx, fixed, recordingJobs } from "../testing/ctx.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

// Every name under example.com answers with this machine, as a hostile or rebinding DNS would, and
// any other name resolves as usual. Only the resolver is replaced: the connection is the node's own.
vi.mock("node:dns", async (orig) => {
  const dns = await orig<typeof import("node:dns")>();
  const lookup = (hostname: string, options: LookupOptions, callback: (...answer: unknown[]) => void) => {
    if (!hostname.endsWith(".example.com")) return dns.lookup(hostname, options, callback as never);
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };
  return { ...dns, lookup };
});

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_outbound_${process.pid}`;
const WS = "ws-outbound";
const PERSON = "ada";
/** What the job worker logged, as one line each. */
const logged: string[] = [];
const recordingLog = {
  info: () => {},
  warn: () => {},
  error: (message: string, fields?: Record<string, unknown>) => void logged.push(`${message} ${JSON.stringify(fields ?? {})}`),
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!URL)("requests to someone else's URL never reach this machine", () => {
  let maintenance: LockSql;
  let sql: LockSql;
  let server: Server;
  let port: number;
  let connections = 0;

  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = sessionConnection(withDatabase(URL!, DB));
    await initSchema(sql as never);
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Acme')`;
    await sql`INSERT INTO users (alias, username, display_name) VALUES (${PERSON}, ${PERSON}, 'Ada')`;
    await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, ${PERSON}, 'member')`;
    const everyone = [`user:${PERSON}`, `org:${WS}`];
    await createDoc(sql as never, { docId: "d1", workspaceId: WS, owner: `user:${PERSON}`, title: "Notes", aclPrincipals: everyone, aclWriters: everyone });

    server = createServer((_req, res) => res.end("\x89PNG\r\n\x1a\n")).on("connection", () => void (connections += 1));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  it("refuses an agent's upload_from_url at a name that resolves to this machine, or a loopback literal, through /mcp, opening no connection", async () => {
    const ctx = agentCtx({
      sql,
      onBehalfOf: PERSON,
      workspaceId: WS,
      env: {
        snapshots: new MemoryBlobStore(),
        media: new MemoryBlobStore(),
        internalSecret: "s".repeat(32),
        settings: fixed({ maxBodyBytes: DEFAULT_MAX_BODY_BYTES, nodeLabel: "Studio" }),
        jobs: recordingJobs(),
        aiSettings: fixed({ enabled: false }),
      },
    });
    const urls = [
      `http://images.example.com:${port}/chart.png`,
      `http://127.0.0.1:${port}/chart.png`,
      `http://127.1:${port}/chart.png`,
      `http://localhost:${port}/chart.png`,
    ];
    for (const url of urls) {
      const answer = await callToolAs(callerFor(ctx), "media_upload", { workspace_id: WS, doc_id: "d1", action: "upload_from_url", url });
      expect(answer, url).toEqual({ isError: true, text: expect.stringContaining("refusing to reach a private or loopback address") });
    }
    expect(connections).toBe(0);
  });

  it("switches off a webhook whose name resolves to this machine, or at a loopback literal, at its first delivery, without retrying or connecting", async () => {
    const hooks = { whk_named: `http://hooks.example.com:${port}/hook`, whk_loop: `http://127.0.0.1:${port}/hook` };
    for (const [webhookId, url] of Object.entries(hooks)) {
      await insertWebhook(sql as never, { webhookId, workspaceId: WS, url, secret: "s3cret", events: [], folderId: null, createdBy: PERSON });
    }
    const jobs = pgJobQueue<IndexMessage>(sql);
    await jobs.send({ kind: "event", workspaceId: WS, type: "doc.created", docId: "d1", actor: `user:${PERSON}`, actorKind: "human" });

    const env = { sql, jobs, publicOrigin: "https://node.test" } as unknown as JobsEnv;
    // The handler's own defaults: webhook deliveries go through the checked connection.
    const worker = startJobWorker<IndexMessage>(sql as never, (batch) => handleJobBatch(env, batch, { db: jobsDb(sql as never), log: recordingLog }), {
      pollMs: 10,
      backoffMs: () => 0,
    });
    const rows = async () =>
      sql<{ webhook_id: string; active: boolean; last_status: number | null; failures: number }[]>`
        SELECT webhook_id, active, last_status, failures FROM webhooks ORDER BY webhook_id`;
    const queued = async () => Number((await sql<{ n: string }[]>`SELECT count(*) AS n FROM jobs`)[0]!.n);
    try {
      // Under vitest's 5 s timeout, so a hook left on fails on its row, not on the clock.
      const end = Date.now() + 4_000;
      while (((await rows()).some((row) => row.active) || (await queued()) > 0) && Date.now() < end) await sleep(20);
    } finally {
      await worker.stop();
    }

    expect(await rows()).toEqual([
      { webhook_id: "whk_loop", active: false, last_status: null, failures: 1 },
      { webhook_id: "whk_named", active: false, last_status: null, failures: 1 },
    ]);
    expect(await queued()).toBe(0);
    for (const webhookId of Object.keys(hooks)) {
      expect(logged.filter((line) => line.includes(webhookId))).toEqual([
        expect.stringMatching(new RegExp(`^job terminal failure.*${webhookId} points at a refused address: refusing to reach a private or loopback address`)),
      ]);
    }
    expect(connections).toBe(0);
  });
});
