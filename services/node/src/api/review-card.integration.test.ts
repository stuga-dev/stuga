/**
 * The review card, the inbox's three groups and the Slack review channel end to end: a run's detail
 * as each reader gets it (who may decide, the sources it cites, its text only to whoever reviews it),
 * Needs you / Waiting on others / Done for each person, and one link-only post per run to a channel
 * whose creator can read the item, through the route table with real actors and a real Postgres.
 * Needs TEST_DATABASE_URL; skips without it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import { closeClients, createClient, initSchema, provisionWorkspace, setUiLanguage, upsertAgentRun, upsertGroup, type Sql } from "@stuga/db";
import { DOC_STORE_VERSION, DocActor } from "@stuga/doc-actor";
import type { IndexMessage, RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, fsBlobStore, type HostedNamespace } from "@stuga/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../auth/context.js";
import { createNodeSettingsStore } from "../config/settings/node.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { jobDeps } from "../jobs/deps.js";
import { handleEvent, handleWebhookDeliver } from "../jobs/webhooks.js";
import { createInternalApi } from "../platform/internal-api.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_card_${process.pid}`;
const WS = "ws-card";
const ORG = `org:${WS}`;
/** Cardliv asks her agent for changes; Carddee is the other admin; Cardsam, Cardcy and Cardana are members. */
const PEOPLE = [
  ["cardliv", "owner", "Liv"],
  ["carddee", "admin", "Dee"],
  ["cardsam", "member", "Sam"],
  ["cardcy", "member", "Cy"],
  ["cardana", "member", "Ana"],
] as const;
type Person = (typeof PEOPLE)[number][0];
const SLACK = "https://hooks.slack.com/services/T0000/B0000/cardChannelToken";

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
    servedOrigin: "https://node.test",
    env,
  } as unknown as Ctx;
}

/** Cardliv's agent. */
function agent(): Ctx {
  return {
    sql,
    surface: "api-key",
    alias: "agent-card",
    displayName: "Scout",
    isAgent: true,
    onBehalfOf: "cardliv",
    principals: ["agent:agent-card", "user:cardliv", ORG],
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

/** A folder Cardliv makes at `level`, with these writers besides her; the workspace reads it. */
async function folder(title: string, level: "review" | "colleague", writers: Person[]): Promise<string> {
  const f = await ok<{ folder_id: string }>(person("cardliv"), "POST", "/api/folders", { title });
  const w = ["user:cardliv", ...writers.map((p) => `user:${p}`)];
  await sql`UPDATE folders SET acl_principals = ${["user:cardliv", ORG]}, acl_writers = ${w},
              own_grants = ${sql.json({ p: ["user:cardliv", ORG], w, c: [] })} WHERE folder_id = ${f.folder_id}`;
  await ok(person("cardliv"), "PATCH", `/api/folders/${f.folder_id}`, { agent_mode: level });
  return f.folder_id;
}

async function doc(parentId: string, by: Person = "cardliv"): Promise<string> {
  const d = await ok<{ doc_id: string }>(person(by), "POST", "/api/docs", {
    title: "Leave policy",
    markdown: "# Leave policy\n\n## Annual leave\n\nTen days a year.\n",
    parent_id: parentId,
  });
  return d.doc_id;
}

/** The agent's change, citing the handbook. */
async function propose(docId: string, replace = "Twelve days[^1]"): Promise<{ run: { id: string }; review: string }> {
  return ok(agent(), "POST", `/api/docs/${docId}/propose`, {
    action: "cited_edits",
    edits: [{ old_string: "Ten days", new_string: replace }],
    citations: [{ n: 1, doc_id: "d_handbook", title: "HR handbook", heading_path: "Leave", content: "Twelve days from 2027." }],
  });
}

interface CardDetail {
  run: { you?: { accept: boolean; reject: boolean; waits_for?: string }; hunks: Array<{ new_string: string }>; hunks_withheld?: true };
  baseline_markdown?: string;
  citations?: Array<{ n: number; title: string; content: string }>;
  deciders?: { aliases: string[]; stand_in: boolean; cause: string | null; also: { owner: boolean; admin: boolean } };
}

const card = (who: Person, docId: string, runId: string) => ok<CardDetail>(person(who), "GET", `/api/docs/${docId}/runs/${runId}?full=1`);
const inbox = async (who: Person, filter: string) =>
  (await ok<{ runs: Array<{ run_id: string; can_decide: boolean }> }>(person(who), "GET", `/api/runs?filter=${filter}`)).runs.map((r) => r.run_id);

async function mirrorRuns(): Promise<void> {
  for (const m of jobs) if (m.kind === "run_index") await upsertAgentRun(sql, m.run as RunIndexEntry);
}

describe.skipIf(!URL)("the review card, the inbox and the review channel", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    for (const [alias, , name] of PEOPLE) await sql`INSERT INTO users (alias, username, display_name) VALUES (${alias}, ${alias}, ${name})`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Team", owner: "cardliv", defaultDocAccess: "workspace_view" });
    for (const [alias, role] of PEOPLE.slice(1)) await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, ${alias}, ${role})`;

    dir = mkdtempSync(join(tmpdir(), "stuga-card-"));
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

  describe("a run's card", () => {
    it("gives whoever may approve the change, its sources and who else may decide it", async () => {
      const f = await folder("Policies", "colleague", ["cardsam", "cardcy", "carddee"]);
      const d = await doc(f);
      const { run } = await propose(d);
      const seen = await card("cardsam", d, run.id);
      expect(seen.run.you).toMatchObject({ accept: true, reject: true });
      expect(seen.run.hunks.map((h) => h.new_string)).toEqual(["Twelve days[^1] a year."]);
      expect(seen.baseline_markdown).toContain("Ten days a year.");
      expect(seen.citations).toEqual([expect.objectContaining({ n: 1, title: "HR handbook", content: "Twelve days from 2027." })]);
      // Everyone else who can edit it, never the person who asked.
      expect(seen.deciders).toEqual({ aliases: ["cardcy", "carddee", "cardsam"], stand_in: false, cause: null, also: { owner: false, admin: false } });
    });

    it("tells whoever asked whom it waits for, and gives them its text", async () => {
      const f = await folder("Policies B", "colleague", ["cardsam"]);
      const d = await doc(f);
      const { run } = await propose(d);
      const own = await card("cardliv", d, run.id);
      expect(own.run.you).toMatchObject({ accept: false, reject: true, waits_for: "colleague" });
      expect(own.run.hunks).toHaveLength(1);
      expect(own.deciders).toEqual({ aliases: ["cardsam"], stand_in: false, cause: null, also: { owner: false, admin: false } });
    });

    it("gives any other reader that it waits, never its text, its sources or who decides it", async () => {
      const f = await folder("Policies C", "colleague", ["cardsam"]);
      const d = await doc(f);
      const { run } = await propose(d);
      const other = await card("cardana", d, run.id);
      expect(other.run.you).toMatchObject({ accept: false, reject: false });
      expect(other.run.hunks).toEqual([]);
      expect(other.run.hunks_withheld).toBe(true);
      expect(other.baseline_markdown).toBeUndefined();
      expect(other.citations).toBeUndefined();
      expect(other.deciders).toBeUndefined();
      expect(JSON.stringify(other)).not.toContain("Twelve days");
    });

    it("names whoever asked as the one who decides below colleague, with nobody else who can edit it", async () => {
      // Carddee is an admin, but cannot edit here.
      const f = await folder("Notes D", "review", ["cardsam"]);
      const d = await doc(f);
      const { run, review } = await propose(d);
      expect(review).toBe("review");
      expect((await card("cardliv", d, run.id)).deciders).toEqual({ aliases: ["cardliv"], stand_in: false, cause: null, also: { owner: false, admin: false } });
    });

    it("adds the item's owner and an admin who can edit it below colleague, and still gives anyone else neither text nor deciders", async () => {
      const f = await folder("Notes H", "review", ["cardsam", "carddee", "cardcy"]);
      const d = await doc(f, "cardsam");
      const { run } = await propose(d);
      const also = { owner: true, admin: true };
      expect((await card("cardliv", d, run.id)).deciders).toEqual({ aliases: ["cardliv"], stand_in: false, cause: null, also });
      const owner = await card("cardsam", d, run.id);
      expect(owner.run.you).toMatchObject({ accept: true, reject: true });
      expect(owner.deciders).toEqual({ aliases: ["cardliv"], stand_in: false, cause: null, also });
      expect((await card("carddee", d, run.id)).run.you).toMatchObject({ accept: true, reject: true });
      const other = await card("cardcy", d, run.id);
      expect(other.run.hunks_withheld).toBe(true);
      expect(other.deciders).toBeUndefined();
    });
  });

  describe("the inbox", () => {
    it("puts a run in Needs you for whoever may approve it, Waiting on others for everyone else, and Done once decided", async () => {
      const f = await folder("Policies E", "colleague", ["cardsam"]);
      const d = await doc(f);
      const { run } = await propose(d);
      await mirrorRuns();
      expect(await inbox("cardsam", "attention")).toContain(run.id);
      expect(await inbox("cardsam", "waiting")).not.toContain(run.id);
      expect(await inbox("cardliv", "waiting")).toContain(run.id);
      expect(await inbox("cardliv", "attention")).not.toContain(run.id);
      expect(await inbox("cardana", "waiting")).toContain(run.id);
      const row = (await ok<{ runs: Array<{ run_id: string; can_decide: boolean }> }>(person("cardana"), "GET", "/api/runs?filter=waiting")).runs.find((r) => r.run_id === run.id);
      expect(row?.can_decide).toBe(false);

      jobs.length = 0;
      await ok(person("cardsam"), "POST", `/api/docs/${d}/runs/${run.id}/decision`, { decision: "accept" });
      await mirrorRuns();
      for (const who of ["cardsam", "cardliv", "cardana"] as const) {
        expect(await inbox(who, "done"), who).toContain(run.id);
        expect([...(await inbox(who, "attention")), ...(await inbox(who, "waiting"))], who).not.toContain(run.id);
      }
    });

    it("puts a run an admin outside its approver group may not approve under Waiting on others for them", async () => {
      await upsertGroup(sql, "group:cardlegal", ["user:cardsam"], WS);
      const f = await folder("Legal G", "colleague", ["cardsam", "carddee"]);
      await ok(person("cardliv"), "PATCH", `/api/folders/${f}`, { approver_group: "group:cardlegal" });
      const d = await doc(f);
      const { run } = await propose(d);
      await mirrorRuns();
      const sam = { ...person("cardsam"), principals: ["user:cardsam", ORG, "group:cardlegal"] } as Ctx;
      expect((await ok<{ runs: Array<{ run_id: string }> }>(sam, "GET", "/api/runs?filter=attention")).runs.map((r) => r.run_id)).toContain(run.id);
      // Cardsam may approve it, so the admin stands in for nobody.
      expect(await inbox("carddee", "attention")).not.toContain(run.id);
      expect(await inbox("carddee", "waiting")).toContain(run.id);
    });
  });

  describe("a Slack review channel", () => {
    const fetched: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const deps = () =>
      jobDeps(env as never, {
        webhookFetch: (async (url: string, init: RequestInit) => {
          fetched.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
          return new Response("ok", { status: 200 });
        }) as never,
      });

    /** Fan out every event the actors sent, as the job worker would, and deliver what that queued. */
    async function deliver(): Promise<void> {
      const events = jobs.filter((m): m is Extract<IndexMessage, { kind: "event" }> => m.kind === "event");
      for (const m of events) await handleEvent(env as never, deps(), m);
      // A review channel's post is queued with its claim, in Postgres; the feed's deliveries through the queue.
      const queued = await sql<{ body: { webhookId: string; eventId: number } }[]>`
        DELETE FROM jobs WHERE body->>'kind' = 'webhook_deliver' RETURNING body`;
      const sent = jobs.filter((m): m is Extract<IndexMessage, { kind: "webhook_deliver" }> => m.kind === "webhook_deliver");
      for (const q of [...queued.map((r) => r.body), ...sent]) {
        await handleWebhookDeliver(env as never, deps(), { kind: "webhook_deliver", webhookId: q.webhookId, eventId: q.eventId });
      }
    }

    beforeEach(() => {
      fetched.length = 0;
    });

    it("is set up only at Slack's incoming-webhook host", async () => {
      expect((await call(person("carddee"), "POST", "/api/webhooks", { kind: "slack", url: "https://example.test/hook" })).status).toBe(400);
      expect((await call(person("carddee"), "POST", "/api/webhooks", { kind: "slack", url: "http://hooks.slack.com/services/T/B/x" })).status).toBe(400);
      expect((await call(person("cardsam"), "POST", "/api/webhooks", { kind: "slack", url: SLACK })).status).toBe(403);
    });

    it("posts once per run that waits for a colleague, link-only, in its creator's language, however many approvers and proposals", async () => {
      const f = await folder("Contracts", "colleague", ["cardsam", "cardcy", "carddee"]);
      await setUiLanguage(sql, "carddee", "de");
      const { webhook } = await ok<{ webhook: { webhook_id: string; kind: string } }>(person("carddee"), "POST", "/api/webhooks", { kind: "slack", url: SLACK, folder_id: f });
      expect(webhook.kind).toBe("slack");
      const generic = await ok<{ webhook: { webhook_id: string } }>(person("carddee"), "POST", "/api/webhooks", { url: "https://93.184.215.14/hook" });
      const d = await doc(f);
      const { run } = await propose(d);
      // The same run grows.
      await ok(agent(), "POST", `/api/docs/${d}/propose`, { action: "str_replace", find: "a year", replace: "each year" });
      await mirrorRuns();
      await deliver();

      const toSlack = fetched.filter((x) => x.url === SLACK);
      expect(toSlack).toHaveLength(1);
      const body = JSON.parse(toSlack[0]!.body) as { text: string };
      expect(body.text).toBe(
        `„Leave policy“: Scout von Liv hat 1 Änderung vorgeschlagen · Prüfung durch Kollegen · <https://node.test/review/${d}/${run.id}?workspace=${WS}|Prüfen>`,
      );
      expect(toSlack[0]!.body).not.toContain("Twelve");
      expect(toSlack[0]!.body).not.toContain("handbook");
      expect(toSlack[0]!.headers["x-stuga-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
      // The generic hook gets the events themselves, and the channel none of them.
      expect(fetched.filter((x) => x.url === "https://93.184.215.14/hook").length).toBeGreaterThan(0);
      expect(await sql`SELECT subject_id FROM review_posts WHERE webhook_id = ${webhook.webhook_id}`).toEqual([{ subject_id: run.id }]);
      await ok(person("carddee"), "DELETE", `/api/webhooks/${generic.webhook.webhook_id}`);
    });

    it("posts nothing at a lower level, or about an item its creator cannot read", async () => {
      const notes = await folder("Team notes", "review", ["cardsam"]);
      const contracts = await folder("Private contracts", "colleague", ["cardsam"]);
      await ok(person("carddee"), "POST", "/api/webhooks", { kind: "slack", url: SLACK });
      const reviewed = await doc(notes);
      await propose(reviewed);
      const hidden = await doc(contracts);
      // Shared with Cardsam alone: the channel's creator, an admin, cannot open it.
      await sql`UPDATE docs SET acl_principals = ${["user:cardliv", "user:cardsam"]}, acl_writers = ${["user:cardliv", "user:cardsam"]} WHERE doc_id = ${hidden}`;
      const { review } = await propose(hidden);
      expect(review).toBe("colleague");
      await mirrorRuns();
      await deliver();
      expect(fetched.filter((x) => x.url === SLACK)).toEqual([]);
    });

    it("posts nothing about a run decided before the post goes out", async () => {
      const f = await folder("Contracts F", "colleague", ["cardsam"]);
      const d = await doc(f);
      const { run } = await propose(d);
      await ok(person("cardsam"), "POST", `/api/docs/${d}/runs/${run.id}/decision`, { decision: "reject" });
      await mirrorRuns();
      await deliver();
      expect(fetched.filter((x) => x.url === SLACK && x.body.includes(run.id))).toEqual([]);
    });
  });
});
