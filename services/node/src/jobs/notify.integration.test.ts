/** Notification storage and sink delivery through the real job queue. Needs TEST_DATABASE_URL; skips without it. */
import { closeClients, createClient, initSchema, pgJobQueue, startJobWorker, type Sql } from "@stuga/db";
import type { IndexMessage, NotifyMessage } from "@stuga/protocol/internal/jobs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobsDb } from "./db.js";
import type { JobsEnv } from "./deps.js";
import type { NotificationPayload } from "./sinks.js";
import { handleJobBatch } from "./worker.js";

const URL = process.env.TEST_DATABASE_URL;
const WS = "ws-notify-jobs";
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const message: NotifyMessage = {
  kind: "notify",
  recipient: "rosa",
  workspaceId: WS,
  eventType: "DOC_SHARED",
  docId: "d1",
  title: "Q3 plan",
  body: "Ada shared a document with you",
  actor: "ada",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!URL)("notification delivery on the job queue", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE notifications, jobs`;
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Notify') ON CONFLICT (workspace_id) DO NOTHING`;
  });

  /** Run the worker until `done` holds, delivering through `deliver`. */
  async function drain(deliver: (n: NotificationPayload) => Promise<void>, done: () => Promise<boolean>): Promise<void> {
    const env = {
      sql,
      jobs: pgJobQueue<IndexMessage>(sql),
      publicOrigin: "https://node.test",
      settings: { current: () => ({ notify: { sink: "webhook", webhookUrl: "https://sink.test/hook" } }) },
    } as unknown as JobsEnv;
    const worker = startJobWorker<IndexMessage>(
      sql,
      (batch) => handleJobBatch(env, batch, { db: jobsDb(sql), log: silentLog, deliver: (_cfg, n) => deliver(n) }),
      { pollMs: 10, backoffMs: () => 0 },
    );
    try {
      const end = Date.now() + 10_000;
      while (!(await done()) && Date.now() < end) await sleep(20);
    } finally {
      await worker.stop();
    }
  }

  const queued = async () => Number((await sql<{ n: string }[]>`SELECT count(*) AS n FROM jobs`)[0]!.n);
  const stored = async () => Number((await sql<{ n: string }[]>`SELECT count(*) AS n FROM notifications`)[0]!.n);

  it("retries a failed sink delivery until it lands, keeping one stored notification", async () => {
    const delivered: NotificationPayload[] = [];
    let failures = 2;
    await pgJobQueue<IndexMessage>(sql).send(message);
    await drain(
      async (n) => {
        if (failures-- > 0) throw new Error("notification sink answered 429");
        delivered.push(n);
      },
      async () => delivered.length > 0 && (await queued()) === 0,
    );
    expect(delivered).toEqual([{ recipient: "rosa", title: "Q3 plan", body: "Ada shared a document with you", url: "https://node.test/doc/d1" }]);
    expect(await stored()).toBe(1);
    expect(await queued()).toBe(0);
  });

  it("stores and delivers a repeat within the hour once", async () => {
    const delivered: NotificationPayload[] = [];
    await pgJobQueue<IndexMessage>(sql).send(message);
    await pgJobQueue<IndexMessage>(sql).send(message);
    await drain(
      async (n) => void delivered.push(n),
      async () => (await queued()) === 0,
    );
    expect(delivered).toHaveLength(1);
    expect(await stored()).toBe(1);
  });

  it("queues no delivery when no sink is configured", async () => {
    const db = jobsDb(sql);
    const row = {
      id: "n-none",
      workspace_id: WS,
      recipient_alias: "rosa",
      event_type: "DOC_SHARED",
      resource_id: "d1",
      resource_title: "Q3 plan",
      resource_url: "https://node.test/doc/d1",
      actor_alias: "ada",
      payload: {},
    };
    expect(await db.insertNotification(row, null)).toBe(true);
    expect(await queued()).toBe(0);
    expect(await db.insertNotification({ ...row, id: "n-sink" }, { kind: "notify_deliver", recipient: "rosa", title: "t", body: "b", url: "u" })).toBe(true);
    expect(await queued()).toBe(1);
    expect(await db.insertNotification({ ...row, id: "n-sink" }, { kind: "notify_deliver", recipient: "rosa", title: "t", body: "b", url: "u" })).toBe(false);
    expect(await queued()).toBe(1);
  });
});
