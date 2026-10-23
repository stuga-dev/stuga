/**
 * The wiki end to end, through the route table with real actors and a real Postgres: links read from
 * each page's approved text as the index job reads it, kept in step through an edit, a rename, the
 * trash and a held page; what links to a page, the Index, the Log and the check, as each reader
 * reads them; marking a page checked; a citation of a page the caller cannot read, refused; and an
 * imported page's citations, checked as of the import whichever page is indexed first.
 * Needs TEST_DATABASE_URL; skips without it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_STORE_VERSION, DatabaseActor } from "@stuga/database-actor";
import { closeClients, createClient, initSchema, provisionWorkspace, upsertAgentRun, type Sql } from "@stuga/db";
import { DOC_STORE_VERSION, DocActor } from "@stuga/doc-actor";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import type { DocWikiLinks, WikiIndex, WikiLint, WikiLog } from "@stuga/protocol/domain/wiki";
import type { IndexMessage, RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, fsBlobStore, type HostedNamespace } from "@stuga/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importWorkspaceArchive, readArchive } from "../archive/import.js";
import type { AccountCtx, Ctx } from "../auth/context.js";
import { createNodeSettingsStore } from "../config/settings/node.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import { zipFiles } from "../lib/zip.js";
import { dispatchJob } from "../jobs/worker.js";
import { nodeBackend } from "../mcp/backend.js";
import { createInternalApi } from "../platform/internal-api.js";
import { fixed } from "../testing/ctx.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_wiki_${process.pid}`;
const WS = "ws-wiki-e2e";
const ORG = `org:${WS}`;
const ORIGIN = "https://node.test";
/** Wkliv owns the workspace and asks her agent for work; Wksam may approve in Policies; Wkana reads. */
const PEOPLE = [
  ["wkeliv", "owner", "Liv"],
  ["wkesam", "member", "Sam"],
  ["wkeana", "member", "Ana"],
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

function agent(of: Person = "wkeliv", alias = "agent-wke"): Ctx {
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

/** Run what the actors queued, as the job worker would: the index (links among it) and the inbox mirror. */
async function work(): Promise<void> {
  for (let round = 0; round < 5 && jobs.length > 0; round++) {
    const batch = jobs.splice(0, jobs.length);
    for (const m of batch) if (m.kind === "index_doc") await dispatchJob(env as never, m);
    for (const m of batch) if (m.kind === "run_index") await upsertAgentRun(sql, m.run as RunIndexEntry);
  }
}

const links = (who: Person, docId: string) => ok<DocWikiLinks>(person(who), "GET", `/api/docs/${docId}/links`);
const linkedFrom = async (who: Person, docId: string) => (await links(who, docId)).linked_from.map((p) => p.doc_id);

async function folder(title: string, readers: string[], writers: string[], level: "review" | "colleague" = "review"): Promise<string> {
  const f = await ok<{ folder_id: string }>(person("wkeliv"), "POST", "/api/folders", { title });
  await sql`UPDATE folders SET acl_principals = ${readers}, acl_writers = ${writers}, own_grants = ${sql.json({ p: readers, w: writers, c: [] })} WHERE folder_id = ${f.folder_id}`;
  if (level !== "review") await ok(person("wkeliv"), "PATCH", `/api/folders/${f.folder_id}`, { agent_mode: level });
  return f.folder_id;
}

/** A person's own edit, as their editor's would be: journaled under them, flushed and so indexed. */
async function edit(docId: string, find: string, replace: string, by: Person = "wkeliv"): Promise<void> {
  const res = await (env.docs as HostedNamespace).get(docId).fetch(`http://actor/apply-edits?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ str_edits: [{ old_string: find, new_string: replace }], agent: by, flush: true }),
  });
  if (!res.ok) throw new Error(`edit ${docId}: ${res.status} ${await res.text()}`);
}

async function page(parentId: string, title: string, body: string): Promise<string> {
  const d = await ok<{ doc_id: string }>(person("wkeliv"), "POST", "/api/docs", { title, parent_id: parentId });
  await edit(d.doc_id, "", `# ${title}\n\n${body}\n`);
  return d.doc_id;
}

describe.skipIf(!URL)("the wiki, end to end", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    for (const [alias, , name] of PEOPLE) await sql`INSERT INTO users (alias, username, display_name) VALUES (${alias}, ${alias}, ${name})`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Team", owner: "wkeliv", defaultDocAccess: "workspace_view" });
    for (const [alias, role] of PEOPLE.slice(1)) await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, ${alias}, ${role})`;
    await sql`INSERT INTO api_keys (key_id, secret_hash, agent_id, owner, workspace_id) VALUES ('k_wke', 'x', 'agent-wke', 'wkeliv', ${WS}), ('k_wks', 'x', 'agent-wks', 'wkesam', ${WS})`;

    dir = mkdtempSync(join(tmpdir(), "stuga-wiki-"));
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

  let policies = "";
  let board = "";
  let policy = "";
  let support = "";
  let plan = "";
  let notes = "";

  it("reads each page's links from its approved text as it is indexed", async () => {
    policies = await folder("Policies", ["user:wkeliv", ORG], ["user:wkeliv", "user:wkesam"], "colleague");
    board = await folder("Board", ["user:wkeliv"], ["user:wkeliv"]);
    policy = await page(policies, "Refund policy", "Refunds take 14 days.");
    support = await page(policies, "Support", `Ask the desk. See [the policy](/doc/${policy}) and [an old page](/doc/zzzzzzzzzzzz).`);
    plan = await page(board, "Merger plan", `It changes [the policy](/doc/${policy}).`);
    notes = await page(policies, "Desk notes", "Notes nobody links to.");
    await work();
    const rows = await sql<{ doc_id: string; target_doc_id: string; kind: string }[]>`SELECT doc_id, target_doc_id, kind FROM doc_links ORDER BY doc_id, target_doc_id`;
    expect(rows).toEqual(
      expect.arrayContaining([
        { doc_id: support, target_doc_id: policy, kind: "link" },
        { doc_id: support, target_doc_id: "zzzzzzzzzzzz", kind: "link" },
        { doc_id: plan, target_doc_id: policy, kind: "link" },
      ]),
    );
    const [summary] = await sql<{ summary: string }[]>`SELECT summary FROM docs WHERE doc_id = ${policy}`;
    expect(summary!.summary).toBe("Refunds take 14 days.");
  });

  it("lists what links to a page as each reader can open it, and nothing of the rest", async () => {
    expect((await linkedFrom("wkeliv", policy)).sort()).toEqual([plan, support].sort());
    const sams = await links("wkesam", policy);
    expect(sams.linked_from.map((p) => [p.doc_id, p.title, p.path])).toEqual([[support, "Support", ["Policies"]]]);
    expect(JSON.stringify(sams)).not.toContain("Merger");
    expect(sams.linked_from_truncated).toBe(false);
    // A page the reader cannot open is not one they ask about.
    expect((await call(person("wkesam"), "GET", `/api/docs/${plan}/links`)).status).toBe(404);
  });

  it("keeps the links through a rename, the trash and a restore", async () => {
    await ok(person("wkeliv"), "PATCH", `/api/docs/${support}`, { title: "Support desk" });
    expect((await links("wkeana", policy)).linked_from.map((p) => p.title)).toEqual(["Support desk"]);
    await ok(person("wkeliv"), "PATCH", `/api/docs/${support}`, { trashed: true });
    expect(await linkedFrom("wkeana", policy)).toEqual([]);
    await ok(person("wkeliv"), "PATCH", `/api/docs/${support}`, { trashed: false });
    expect(await linkedFrom("wkeana", policy)).toEqual([support]);
  });

  it("refuses a citation of a page the caller cannot read, or of none, saying the same of both", async () => {
    const cite = (who: Ctx, docId: string) =>
      call(who, "POST", `/api/docs/${notes}/propose`, {
        action: "cited_edits",
        edits: [{ old_string: "Notes nobody links to.", new_string: "Notes on refunds [^1]." }],
        citations: [{ n: 1, doc_id: docId, title: "Anything" }],
      });
    const secret = await cite(agent("wkesam", "agent-wks"), plan);
    expect(secret.status).toBe(400);
    const secretText = await secret.text();
    expect(secretText).toContain("citation_not_found");
    const missing = await cite(agent("wkesam", "agent-wks"), "nosuchdocid1");
    expect((await missing.text()).replace("nosuchdocid1", plan)).toBe(secretText);
    // Over MCP, the same refusal.
    const mcp = await nodeBackend(agent("wkesam", "agent-wks")).propose(notes, {
      action: "cited_edits",
      edits: [{ old_string: "Notes nobody links to.", new_string: "x [^1]" }],
      citations: [{ n: 1, doc_id: plan, title: "x", heading_path: null, content: "" }],
    });
    expect(mcp).toMatchObject({ error: expect.stringContaining("citation_not_found") });
    // Nothing was proposed.
    expect(await sql`SELECT 1 FROM agent_runs WHERE doc_id = ${notes}`).toHaveLength(0);
  });

  let citingRun = "";

  it("records a citation once its change is approved, and who approved it", async () => {
    const proposed = await ok<{ run: { id: string }; change_id?: string }>(agent(), "POST", `/api/docs/${support}/propose`, {
      action: "cited_edits",
      edits: [{ old_string: "Ask the desk.", new_string: "Refunds take 14 days [^1]." }],
      citations: [{ n: 1, doc_id: policy, title: "Refund policy", content: "Refunds take 14 days." }],
      change_title: "Support sync, 2026-10-22",
    });
    citingRun = proposed.run.id;
    await work();
    // Waiting text is no link yet.
    expect((await links("wkeliv", policy)).linked_from.find((p) => p.doc_id === support)!.kinds).toEqual(["link"]);
    await ok(person("wkesam"), "POST", `/api/docs/${support}/runs/${citingRun}/decision`, { decision: "accept" });
    await work();
    expect((await links("wkeliv", policy)).linked_from.find((p) => p.doc_id === support)!.kinds).toEqual(["citation", "link"]);
    const [run] = await sql<{ decided_by: string[] }[]>`SELECT decided_by FROM agent_runs WHERE run_id = ${citingRun}`;
    expect(run!.decided_by).toEqual(["wkesam"]);
  });

  it("marks a page as needing checking once a page it cites changes, for those who can open that page", async () => {
    expect((await links("wkesam", support)).needs_checking).toEqual([]);
    // The policy changes, through an approved AI change.
    const changed = await ok<{ run: { id: string } }>(agent(), "POST", `/api/docs/${policy}/propose`, { action: "str_replace", find: "14 days", replace: "30 days" });
    await ok(person("wkesam"), "POST", `/api/docs/${policy}/runs/${changed.run.id}/decision`, { decision: "accept" });
    await work();
    const sams = await links("wkesam", support);
    expect(sams.needs_checking).toEqual([{ doc_id: policy, title: "Refund policy", changed_at: expect.any(String) }]);
    expect(sams.can_mark_checked).toBe(true);
    // Ana reads it, and may not edit it: told, and not offered the mark.
    expect((await links("wkeana", support)).can_mark_checked).toBe(false);
    const index = await ok<WikiIndex>(person("wkeana"), "GET", "/api/wiki/index");
    const entry = index.sections.flatMap((s) => s.pages).find((p) => p.doc_id === support)!;
    expect(entry.needs_checking).toBe(true);
    const policyEntry = index.sections.flatMap((s) => s.pages).find((p) => p.doc_id === policy)!;
    expect(policyEntry.changed_by).toEqual([{ kind: "person", name: "Sam" }]);
    expect(policyEntry.summary).toBe("Refunds take 30 days.");
    // Nobody who cannot open the cited page hears that it changed.
    await sql`UPDATE docs SET acl_principals = ${["user:wkeliv", "user:wkesam"]} WHERE doc_id = ${policy}`;
    expect((await links("wkeana", support)).needs_checking).toEqual([]);
    expect((await ok<WikiLint>(person("wkeana"), "GET", "/api/wiki/lint")).needs_checking).toEqual([]);
    await sql`UPDATE docs SET acl_principals = ${["user:wkeliv", ORG]} WHERE doc_id = ${policy}`;
  });

  it("checks the wiki for each reader, and tells an agent to propose the fixes as one change", async () => {
    const lint = await ok<WikiLint>(person("wkesam"), "GET", "/api/wiki/lint");
    expect(lint.needs_checking.map((p) => p.doc_id)).toEqual([support]);
    expect(lint.orphans.map((p) => p.doc_id)).toContain(notes);
    expect(lint.orphans.map((p) => p.doc_id)).not.toContain(policy);
    expect(lint.broken_links).toEqual([
      { doc_id: support, title: "Support desk", path: ["Policies"], links: [{ href: "/doc/zzzzzzzzzzzz", kind: "link", reason: "not_found" }] },
    ]);
    // Liv's private page is no reader's but hers: its links break nothing for Sam, nor show.
    expect(JSON.stringify(lint)).not.toContain(plan);
    const viaAgent = await nodeBackend(agent()).wikiLint(undefined);
    expect(viaAgent).toMatchObject({ needs_checking: [expect.objectContaining({ doc_id: support })] });
    expect(await nodeBackend(agent()).wikiLint("nosuchfolder")).toEqual({ error: "folder not found" });
    expect((await call(person("wkesam"), "GET", `/api/wiki/lint?folder_id=${board}`)).status).toBe(404);
  });

  it("lets a person who can edit the page mark it checked, never an agent", async () => {
    expect((await call(agent(), "POST", `/api/docs/${support}/links/checked`)).status).toBe(403);
    expect((await call(person("wkeana"), "POST", `/api/docs/${support}/links/checked`)).status).toBe(403);
    const marked = await ok<DocWikiLinks & { marked: number }>(person("wkesam"), "POST", `/api/docs/${support}/links/checked`);
    expect(marked.marked).toBe(1);
    expect(marked.needs_checking).toEqual([]);
    expect((await ok<WikiLint>(person("wkeana"), "GET", "/api/wiki/lint")).needs_checking).toEqual([]);
  });

  it("follows a person's edit: a link they take out is gone, and one they add is there", async () => {
    await edit(support, " and [an old page](/doc/zzzzzzzzzzzz)", "", "wkesam");
    await edit(notes, "Notes nobody links to.", `Notes on [the support desk](/doc/${support}).`, "wkesam");
    await work();
    expect((await ok<WikiLint>(person("wkesam"), "GET", "/api/wiki/lint")).broken_links).toEqual([]);
    expect(await linkedFrom("wkeana", support)).toEqual([notes]);
    const [row] = await sql<{ text_changed_by: string[] }[]>`SELECT text_changed_by FROM docs WHERE doc_id = ${notes}`;
    expect(row!.text_changed_by).toEqual(["wkesam"]);
  });

  it("logs the decided changes, the change's title only for whoever asked or decided it", async () => {
    const sams = await ok<WikiLog>(person("wkesam"), "GET", "/api/wiki/log");
    expect(sams.entries.map((e) => [e.kind, e.outcome, e.pages.map((p) => p.doc_id)])).toEqual([
      ["run", "approved", [policy]],
      ["change", "approved", [support]],
    ]);
    const change = sams.entries[1]!;
    expect(change).toMatchObject({
      title: "Support sync, 2026-10-22",
      asked_by: { kind: "person", name: "Liv" },
      decided_by: [{ kind: "person", name: "Sam" }],
      agent: expect.objectContaining({ name: "Scout" }),
    });
    const anas = await ok<WikiLog>(person("wkeana"), "GET", "/api/wiki/log");
    expect(anas.entries[1]!.title).toBeNull();
    expect(JSON.stringify(anas)).not.toContain("Support sync");
    // Through MCP, names as an agent's answers give them.
    const viaAgent = await nodeBackend(agent()).wikiLog(undefined, 1);
    expect(viaAgent).toMatchObject({ entries: [expect.objectContaining({ pages: [expect.objectContaining({ doc_id: policy })] })], next: expect.any(String) });
    const older = await nodeBackend(agent()).wikiLog((viaAgent as WikiLog).next!, 5);
    expect((older as WikiLog).entries.map((e) => e.kind)).toEqual(["change"]);
    expect((await call(person("wkesam"), "GET", "/api/wiki/log?before=nonsense")).status).toBe(400);
    expect((await call(person("wkesam"), "GET", "/api/wiki/log?before=999999999999999:run_x")).status).toBe(400);
    // An agent reads a change's title only when the change is its own, whoever its person is.
    const own = (await nodeBackend(agent()).wikiLog(undefined, 5)) as WikiLog;
    expect(own.entries.find((e) => e.kind === "change")!.title).toBe("Support sync, 2026-10-22");
    const samsAgent = (await nodeBackend(agent("wkesam", "agent-wks")).wikiLog(undefined, 5)) as WikiLog;
    expect(samsAgent.entries.find((e) => e.kind === "change")!.title).toBeNull();
  });

  it("leaves a page kept out of search out of an agent's Index, and in a person's", async () => {
    await sql`UPDATE docs SET search_hidden = TRUE WHERE doc_id = ${notes}`;
    const pages = (index: WikiIndex) => index.sections.flatMap((s) => s.pages).map((p) => p.doc_id);
    expect(pages((await nodeBackend(agent()).wikiIndex(undefined)) as WikiIndex)).not.toContain(notes);
    expect(pages(await ok<WikiIndex>(person("wkeliv"), "GET", "/api/wiki/index"))).toContain(notes);
    await sql`UPDATE docs SET search_hidden = FALSE WHERE doc_id = ${notes}`;
  });

  it("names what links to a page in an agent's metadata, as the agent's person reads it", async () => {
    const meta = (await nodeBackend(agent("wkesam", "agent-wks")).docMetadata(policy)) as Record<string, unknown>;
    expect(meta.linked_from).toEqual([{ doc_id: support, title: "Support desk", kinds: ["citation", "link"] }]);
    expect(meta.needs_checking).toEqual([]);
  });

  it("takes an imported page's citations as checked, though it is indexed before the page it cites, until that page changes", async () => {
    const imported = "ws-wiki-import";
    await provisionWorkspace(sql, { workspaceId: imported, name: "Imported", owner: "wkeliv" });
    const doc = (path: string, parent: string | null, title: string) => ({
      kind: "doc",
      path,
      parent,
      title,
      title_source: "heading",
      agent_mode: "review",
      locked: false,
      search_hidden: false,
      agent_instructions: "",
    });
    const manifest = {
      format: "stuga-workspace",
      version: 1,
      generator: "stuga test",
      exported_at: "2026-10-22T10:00:00Z",
      workspace: { name: "Imported", agent_instructions: "" },
      items: [
        { kind: "folder", path: "Sources", parent: null, title: "Sources", agent_instructions: "" },
        doc("Sources/Meeting.md", "Sources", "Meeting"),
        doc("Refunds.md", null, "Refunds"),
      ],
    };
    const files: Record<string, string> = {
      "stuga.json": JSON.stringify(manifest),
      "Sources/Meeting.md": "# Meeting\n\n## Decisions\n\nRefunds take 30 days.\n",
      "Refunds.md": '# Refunds\n\nRefunds take 30 days[^1].\n\n[^1]: [Meeting — Decisions](Sources/Meeting.md) "Refunds take 30 days."\n',
    };
    const bytes = zipFiles(Object.entries(files).map(([name, data]) => ({ name, data: new TextEncoder().encode(data) })), "deflate");
    const account = { sql, surface: "web", alias: "wkeliv", displayName: "Liv", isAgent: false, env } as unknown as AccountCtx;
    const out = await importWorkspaceArchive(account, imported, await readArchive(bytes, { maxImageBytes: 10 * 1024 * 1024 }));
    const meeting = out.ids.docs.get("Sources/Meeting.md")!;
    const refunds = out.ids.docs.get("Refunds.md")!;

    // The page citing the meeting is indexed first, the meeting last.
    const rank = (m: IndexMessage) => (m.kind !== "index_doc" ? 1 : m.docId === refunds ? 0 : m.docId === meeting ? 2 : 1);
    jobs.push(...jobs.splice(0, jobs.length).sort((a, b) => rank(a) - rank(b)));
    await work();
    const [cited, citing] = await sql<{ text_changed_at: Date }[]>`
      SELECT text_changed_at FROM docs WHERE doc_id IN (${meeting}, ${refunds}) ORDER BY doc_id = ${refunds}`;
    expect(citing!.text_changed_at.getTime()).toBeLessThanOrEqual(cited!.text_changed_at.getTime());

    const liv = { ...person("wkeliv"), workspaceId: imported, principals: ["user:wkeliv", `org:${imported}`] } as Ctx;
    expect((await ok<DocWikiLinks>(liv, "GET", `/api/docs/${meeting}/links`)).linked_from.map((p) => [p.doc_id, p.kinds])).toEqual([[refunds, ["citation"]]]);
    expect((await ok<DocWikiLinks>(liv, "GET", `/api/docs/${refunds}/links`)).needs_checking).toEqual([]);
    expect((await ok<WikiLint>(liv, "GET", "/api/wiki/lint")).needs_checking).toEqual([]);

    // A change to the meeting after the import is one to check.
    await edit(meeting, "30 days", "45 days");
    await work();
    expect((await ok<DocWikiLinks>(liv, "GET", `/api/docs/${refunds}/links`)).needs_checking).toEqual([
      { doc_id: meeting, title: "Meeting", changed_at: expect.any(String) },
    ]);
  });

  it("leaves a page a change holds out of the wiki until it is approved", async () => {
    const created = await ok<{ doc_id: string; held?: boolean; change_id?: string }>(agent(), "POST", "/api/docs", { title: "Refund exceptions", parent_id: policies, change_title: "Exceptions, 2026-10-22" });
    expect(created.held).toBe(true);
    // Its owner writes a link into it herself; a held page is still nobody's wiki but theirs to finish.
    await sql`INSERT INTO doc_links (doc_id, workspace_id, target_doc_id, kind, context_hash) VALUES (${created.doc_id}, ${WS}, ${policy}, 'link', 'x')`;
    expect(await linkedFrom("wkeliv", policy)).not.toContain(created.doc_id);
    const index = await ok<WikiIndex>(person("wkeliv"), "GET", "/api/wiki/index");
    expect(JSON.stringify(index)).not.toContain("Refund exceptions");
  });
});
