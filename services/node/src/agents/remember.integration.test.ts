/**
 * Save to Stuga against a real Postgres: where a plan puts each point among pages indexed as a flush
 * indexes them, what it says is already there or may be replaced, the person's My notes, the session
 * index the Claude Code plugin starts with, and who wrote what a recall finds. Needs
 * TEST_DATABASE_URL; skips without it.
 */
import {
  closeClients,
  createClient,
  createDoc,
  createFolder,
  initSchema,
  indexDoc,
  listFolders,
  provisionWorkspace,
  upsertAgentRun,
  type Sql,
} from "@stuga/db";
import { headingAwareChunk } from "@stuga/ai";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchDocuments } from "../api/search.js";
import type { Ctx, McpCaller } from "../auth/context.js";
import { nodeBackend } from "../mcp/backend.js";
import { getSessionIndex } from "../mcp/session-index.js";
import { fixed, recordingJobs } from "../testing/ctx.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import type { RememberCandidate, RememberPlanPoint } from "@stuga/agent-surface/backend";
import { CANDIDATES_MAX, OTHER_LANGUAGE_NOTE, planRemember } from "./remember.js";

/** A place's id: a page's or a table's, or a folder's for a new page. */
const idOf = (c: RememberPlanPoint["candidates"][number]): string => (c.kind === "page" ? c.doc_id : c.kind === "row" ? c.database_id : c.folder_id);

/** A point's page candidates, the new pages a folder could hold left out. */
const pagesOf = (point: RememberPlanPoint): RememberCandidate[] => point.candidates.filter((c): c is RememberCandidate => c.kind === "page");

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_remember_${process.pid}`;
const WS = "ws-wiki";
const ORG = `org:${WS}`;
const ORIGIN = "https://node.test";

let maintenance: LockSql;
let sql: Sql;
let jobs: ReturnType<typeof recordingJobs>;
let env: Record<string, unknown>;

/** `who`'s agent, with their reach in the workspace; `scope` narrows it as a key's folders do. */
function agentOf(who: string, over: Partial<Record<keyof Ctx, unknown>> = {}): Ctx {
  return {
    sql,
    surface: "mcp",
    alias: `agent-${who}`,
    displayName: "Scout",
    isAgent: true,
    onBehalfOf: who,
    principals: [`agent:agent-${who}`, `user:${who}`, ORG],
    workspaceId: WS,
    role: who === "dee" ? "admin" : "member",
    servedOrigin: ORIGIN,
    arrival: "local",
    env,
    ...over,
  } as unknown as Ctx;
}

/** A page indexed as a flush indexes it: its body, and one passage per section. */
async function page(
  docId: string,
  title: string,
  sections: Array<[heading: string | null, text: string]>,
  opts: { parentId?: string | null; readers?: string[]; writers?: string[]; owner?: string; hidden?: boolean } = {},
): Promise<void> {
  const owner = `user:${opts.owner ?? "liv"}`;
  await createDoc(sql, {
    docId,
    workspaceId: WS,
    owner,
    title,
    parentId: opts.parentId ?? null,
    aclPrincipals: opts.readers ?? [owner, ORG],
    aclWriters: opts.writers ?? [owner, ORG],
  });
  const body = sections.map(([h, t]) => (h ? `## ${h}\n\n${t}` : t)).join("\n\n");
  await indexDoc(sql, {
    embeddingDims: EMBEDDING_DIMS,
    docId,
    snapshotSeq: 1,
    title,
    searchText: body,
    embeddingHash: `h-${docId}`,
    chunks: sections.map(([h, t], i) => ({ content: h ? `## ${h}\n\n${t}` : t, headingPath: h, embedding: null, embedHash: `${docId}-${i}` })),
  });
  if (opts.hidden) await sql`UPDATE docs SET search_hidden = TRUE WHERE doc_id = ${docId}`;
}

async function folder(folderId: string, title: string, opts: { readers?: string[]; writers?: string[]; instructions?: string; mode?: string } = {}) {
  const readers = opts.readers ?? ["user:liv", ORG];
  const writers = opts.writers ?? ["user:liv", ORG];
  await createFolder(sql, {
    folderId,
    workspaceId: WS,
    owner: "user:liv",
    title,
    aclPrincipals: readers,
    aclWriters: writers,
    ...(opts.instructions ? { agentInstructions: opts.instructions } : {}),
  });
  if (opts.mode) await sql`UPDATE folders SET agent_mode = ${opts.mode} WHERE folder_id = ${folderId}`;
}

describe.skipIf(!URL)("Save to Stuga", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    for (const [alias, name, language] of [
      ["liv", "Liv", null],
      ["sam", "Sam", "de"],
      ["dee", "Dee", null],
      ["ana", "Ana", null],
      ["bo", "Bo", null],
    ] as const) {
      await sql`INSERT INTO users (alias, username, display_name, ui_language) VALUES (${alias}, ${alias}, ${name}, ${language})`;
    }
    await provisionWorkspace(sql, { workspaceId: WS, name: "Acme", owner: "liv", defaultDocAccess: "workspace_edit" });
    await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${WS}, 'sam', 'member'), (${WS}, 'dee', 'admin'),
                                                                     (${WS}, 'ana', 'member'), (${WS}, 'bo', 'member')`;
    jobs = recordingJobs();
    env = {
      sql,
      publicOrigin: ORIGIN,
      extraOrigins: [],
      jobs,
      embeddingDims: EMBEDDING_DIMS,
      searchLanguages: fixed([]),
      aiSettings: fixed({ chat: { enabled: false }, embed: { enabled: false, searchCutoff: null } }),
      settings: fixed({ nodeLabel: "Studio", nodeName: "Studio", maxBodyBytes: 1_000_000 }),
      nodeId: "node-1",
    };

    await folder("f_support", "Support", { instructions: "One page per policy. Write the rule first, then who owns it." });
    await folder("f_policies", "Policies", { mode: "colleague" });
    await folder("f_hr", "Private HR", { readers: ["user:dee"], writers: ["user:dee"] });
    await page("d_refunds", "Refund policy", [
      [null, "How we handle refunds."],
      ["Approval", "Refunds over 500 euros need finance approval. Liv answers refund questions on Mondays."],
      ["Timing", "Refunds go out within ten working days."],
    ], { parentId: "f_support" });
    await page("d_travel", "Travel policy", [["Booking", "Book trains for trips under four hours. Flights need approval from Sam."]], { parentId: "f_policies" });
    await page("d_onboarding", "Onboarding", [["First day", "New hires get a laptop on day one."]]);
    await page("d_hr", "Salary advances", [["Advances", "Refunds of salary advances over 500 euros need finance approval from Dee."]], {
      parentId: "f_hr",
      readers: ["user:dee"],
      writers: ["user:dee"],
      owner: "dee",
    });
    await page("d_board", "Board minutes", [["October", "The board agreed: refunds over 500 euros need finance approval."]], {
      readers: ["user:dee", ORG],
      writers: ["user:dee"],
      owner: "dee",
    });
    await page("d_hidden", "Refund drafts", [[null, "Refund ideas nobody should find."]], { hidden: true });
  });

  afterAll(async () => {
    await closeClients();
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  it("puts a correction first in the page its topic names, under the section, and names the sentence it replaces", async () => {
    const plan = await planRemember(agentOf("liv"), [{ text: "Refunds over 300 euros need finance approval.", topic: "Refunds" }]);
    const [point] = plan.points;
    expect(point!.candidates.length).toBeGreaterThan(0);
    expect(point!.candidates.length).toBeLessThanOrEqual(CANDIDATES_MAX);
    expect(point!.candidates[0]).toMatchObject({
      doc_id: "d_refunds",
      title: "Refund policy",
      folder_path: ["Support"],
      section: "Approval",
      heading_path: "Approval",
      review: { mode: "review" },
      instructions_labels: ['Folder "Support"'],
      url: `${ORIGIN}/doc/d_refunds`,
    });
    expect(point!.candidates[0]!.why).toContain('its title names the topic "Refunds"');
    expect(pagesOf(point!)[0]!.excerpt).toContain("Refunds over 500 euros");
    expect(point!.already_saved).toEqual([]);
    expect(point!.possibly_replaces).toContainEqual(
      expect.objectContaining({ doc_id: "d_refunds", sentence: "Refunds over 500 euros need finance approval.", hint: "possibly_replaces", can_edit: true }),
    );
    // What people wrote for agents about these places, the folder's own included.
    expect(plan.instructions?.map((l) => [l.kind, l.title])).toEqual(expect.arrayContaining([["folder", "Support"]]));
    expect(plan.folders_with_instructions).toEqual([{ folder_id: "f_support", path: ["Support"], instructions_label: 'Folder "Support"' }]);
    expect(plan).toMatchObject({ semantic: false, degraded: false });
  });

  it("never names what the person cannot read, and offers no page they cannot edit", async () => {
    const plan = await planRemember(agentOf("liv"), [{ text: "Refunds over 500 euros need finance approval.", topic: "Refunds" }]);
    const text = JSON.stringify(plan);
    expect(text).not.toContain("d_hr");
    expect(text).not.toContain("Salary advances");
    expect(text).not.toContain("Private HR");
    expect(text).not.toContain("d_hidden");
    const [point] = plan.points;
    expect(pagesOf(point!).map((c) => c.doc_id)).not.toContain("d_board");
    // Already there, word for word: in the page Liv edits and in the minutes she only reads.
    expect(point!.already_saved.map((a) => a.doc_id).sort()).toEqual(["d_board", "d_refunds"]);
    expect(point!.possibly_replaces.map((r) => r.doc_id)).not.toContain("d_refunds");

    // Dee reads both: her plan finds the advances page, in its folder.
    const dee = (await planRemember(agentOf("dee"), [{ text: "Salary advances over 500 euros need finance approval from Dee." }])).points[0]!;
    expect(dee.candidates[0]).toMatchObject({ doc_id: "d_hr", folder_path: ["Private HR"] });
  });

  it("reports the review level a write there gets, and a page the person cannot edit as one to tell them about", async () => {
    const plan = await planRemember(agentOf("liv"), [{ text: "Flights need approval from Sam and finance.", topic: "Travel" }]);
    const [point] = plan.points;
    expect(point!.candidates[0]).toMatchObject({ doc_id: "d_travel", review: { mode: "colleague", reason: "this document waits for a colleague's approval" } });
    const minutes = await planRemember(agentOf("liv"), [{ text: "The board agreed: refunds over 800 euros need finance approval." }]);
    expect(minutes.points[0]!.possibly_replaces).toContainEqual(
      expect.objectContaining({ doc_id: "d_board", hint: "possibly_replaces", can_edit: false }),
    );
  });

  it("plans several points in one call, each in its order", async () => {
    const plan = await planRemember(agentOf("liv"), [
      { text: "New hires get a laptop and a phone on day one.", topic: "Onboarding" },
      { text: "Refunds go out within five working days.", topic: "Refunds" },
    ]);
    expect(plan.points.map((p) => [p.index, pagesOf(p)[0]?.doc_id])).toEqual([
      [0, "d_onboarding"],
      [1, "d_refunds"],
    ]);
    expect(pagesOf(plan.points[1]!)[0]!.section).toBe("Timing");
  });

  it("makes the person's My notes once, private to them, in their language, with AI edits applying directly", async () => {
    jobs.send.mockClear();
    const first = await planRemember(agentOf("sam"), [{ text: "Sam's desk moves to the second floor in November." }]);
    expect(first.home).toMatchObject({ title: "Meine Notizen", created: true, review: { mode: "auto" }, pages: [] });
    const again = await planRemember(agentOf("sam"), [{ text: "Sam prefers calls over email." }]);
    expect(again.home).toMatchObject({ folder_id: first.home!.folder_id, created: false });

    const rows = await sql<{ folder_id: string; owner: string; acl_principals: string[]; acl_writers: string[]; agent_mode: string; parent_id: string | null }[]>`
      SELECT folder_id, owner, acl_principals, acl_writers, agent_mode, parent_id FROM folders WHERE home_of = 'sam'`;
    expect(rows).toEqual([
      { folder_id: first.home!.folder_id, owner: "user:sam", acl_principals: ["user:sam"], acl_writers: ["user:sam"], agent_mode: "auto", parent_id: null },
    ]);
    // Nobody else sees it, a workspace admin included.
    for (const who of ["liv", "dee"]) {
      const theirs = await listFolders(sql, [`user:${who}`, ORG], WS);
      expect(theirs.map((f) => f.folder_id), who).not.toContain(first.home!.folder_id);
    }
    expect(jobs.audits()).toEqual([expect.objectContaining({ action: "folder.create", targetId: first.home!.folder_id, detail: { parent_id: null, my_notes: true } })]);

    // Two first saves at once make one.
    const [a, b] = await Promise.all([planRemember(agentOf("ana"), [{ text: "x" }]), planRemember(agentOf("ana"), [{ text: "y" }])]);
    expect(a.home!.folder_id).toBe(b.home!.folder_id);
    expect([a.home!.created, b.home!.created].sort()).toEqual([false, true]);
    expect(a.home!.title).toBe("My notes");
  });

  it("lists the pages in My notes, and suggests the one on the topic", async () => {
    const home = (await planRemember(agentOf("liv"), [{ text: "x" }])).home!;
    await page("d_mine", "Hiring", [[null, "We hire two engineers in Q1."]], { parentId: home.folder_id, readers: ["user:liv", "agent:agent-liv"], writers: ["user:liv", "agent:agent-liv"] });
    const plan = await planRemember(agentOf("liv"), [{ text: "We hire three engineers in Q1.", topic: "Hiring" }]);
    expect(plan.home!.pages).toEqual([{ doc_id: "d_mine", title: "Hiring" }]);
    expect(plan.points[0]!.candidates[0]).toMatchObject({ doc_id: "d_mine", folder_path: ["My notes"], review: { mode: "auto" } });
    expect(plan.points[0]!.possibly_replaces[0]).toMatchObject({ doc_id: "d_mine", sentence: "We hire two engineers in Q1." });
    // Sam's agent never finds it.
    expect(JSON.stringify(await planRemember(agentOf("sam"), [{ text: "We hire three engineers in Q1.", topic: "Hiring" }]))).not.toContain("d_mine");
  });

  it("makes no My notes for a key confined to some folders, and plans within them", async () => {
    const scoped = agentOf("bo", { scope: { folders: ["f_support"], readOnly: false, credentialId: "k1" } });
    const plan = await planRemember(scoped, [{ text: "Refunds over 300 euros need finance approval.", topic: "Refunds" }]);
    expect(plan.home).toBeNull();
    expect(plan.home_note).toContain("confined to some folders");
    expect(pagesOf(plan.points[0]!).map((c) => c.doc_id)).toEqual(["d_refunds"]);
    expect((await sql`SELECT 1 FROM folders WHERE home_of = 'bo'`).length).toBe(0);
  });

  it("starts a Claude Code session with the pages the connection reaches, team pages first, own notes last", async () => {
    const caller: McpCaller = {
      account: { ...agentOf("liv"), workspaceId: undefined } as unknown as McpCaller["account"],
      workspaces: null,
      readOnly: false,
    };
    jobs.send.mockClear();
    const res = await getSessionIndex({ caller, req: new Request(`${ORIGIN}/api/agent/session-index`), url: new globalThis.URL(`${ORIGIN}/api/agent/session-index`), match: [] });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const index = (await res.json()) as { workspaces: Array<{ workspace_id: string; name: string; my_notes: string | null }>; docs: Array<Record<string, unknown>>; total: number };
    expect(index.workspaces).toEqual([{ workspace_id: WS, name: "Acme", my_notes: expect.any(String), counts: { team: index.docs.length - 1, mine: 1 } }]);
    const ids = index.docs.map((d) => d.doc_id);
    expect(ids).toContain("d_refunds");
    expect(ids).not.toContain("d_hr");
    expect(ids).not.toContain("d_hidden");
    expect(ids.at(-1)).toBe("d_mine");
    expect(index.docs.find((d) => d.doc_id === "d_mine")).toMatchObject({ mine: true, path: ["My notes"] });
    expect(index.docs.find((d) => d.doc_id === "d_refunds")).toMatchObject({ title: "Refund policy", type: "page", path: ["Support"], mine: false });
    expect(index.total).toBe(index.docs.length);
    expect(jobs.audits()).toEqual([expect.objectContaining({ action: "mcp.session_index", workspaceId: WS, detail: expect.objectContaining({ docs: index.docs.length }) })]);
    // Nothing but ids, titles, folders and dates.
    expect(JSON.stringify(index)).not.toContain("finance approval");
  });

  it("tells an agent who wrote what a recall finds, and a person's search answer stays as it was", async () => {
    // Sam's agent, named by the person it acts for whatever its client called it, and Liv's in-app co-author.
    await sql`INSERT INTO api_keys (key_id, secret_hash, agent_id, owner, workspace_id, name) VALUES ('k_sam', 'x', 'agent-sam', 'sam', ${WS}, 'Scout')`;
    await sql`INSERT INTO versions (doc_id, seq, authors, blob_key) VALUES ('d_refunds', 1, ${["liv", "agent-sam", "panel:liv", "Scout"]}, 'k1')`;
    const at = Date.now();
    await upsertAgentRun(sql, {
      runId: "run_1",
      workspaceId: WS,
      docId: "d_refunds",
      docKind: "prose",
      docTitle: "Refund policy",
      source: "connector",
      agent: "Scout",
      agentAlias: "agent-sam",
      reviewer: "sam",
      status: "closed",
      reviewMode: "auto",
      approverGroup: null,
      approvedBy: [],
      autoApplied: true,
      reverted: false,
      acknowledged: false,
      pending: 0,
      accepted: 0,
      rejected: 0,
      conflicts: 0,
      applied: 1,
      client: null,
      model: null,
      createdAt: at,
      updatedAt: at,
    });
    // A change by Dee's agent waits for a colleague: none of its text is in the page.
    await upsertAgentRun(sql, {
      runId: "run_2",
      workspaceId: WS,
      docId: "d_refunds",
      docKind: "prose",
      docTitle: "Refund policy",
      source: "connector",
      agent: "Helper",
      agentAlias: "agent-dee",
      reviewer: "dee",
      status: "open",
      reviewMode: "colleague",
      approverGroup: null,
      approvedBy: [],
      autoApplied: false,
      reverted: false,
      acknowledged: false,
      pending: 2,
      accepted: 0,
      rejected: 0,
      conflicts: 0,
      applied: 0,
      client: null,
      model: null,
      createdAt: Date.parse("2026-10-20T09:00:00.000Z"),
      updatedAt: at,
    });
    // One of Liv's own, by her agent: what it changes is listed, read from the document's actor.
    await upsertAgentRun(sql, {
      runId: "run_3",
      workspaceId: WS,
      docId: "d_refunds",
      docKind: "prose",
      docTitle: "Refund policy",
      source: "connector",
      agent: "Claude",
      agentAlias: "agent-liv",
      reviewer: "liv",
      status: "open",
      reviewMode: "review",
      approverGroup: null,
      approvedBy: [],
      autoApplied: false,
      reverted: false,
      acknowledged: false,
      pending: 1,
      accepted: 0,
      rejected: 0,
      conflicts: 0,
      applied: 0,
      client: null,
      model: null,
      createdAt: Date.parse("2026-10-21T09:00:00.000Z"),
      updatedAt: at,
    });
    const asked: string[] = [];
    env.docs = {
      get: () => ({
        fetch: async (url: string) => {
          asked.push(url);
          // The approved text, then the run's changes, which are told against it.
          if (!url.includes("/runs/detail")) {
            return Response.json({
              markdown: "How we handle refunds.\n\n## Approval\n\nRefunds over 500 euros need finance approval.\n\n## Timing\n\nRefunds go out within ten working days.",
            });
          }
          return Response.json({
            hunks: [
              { id: "h1", old_string: "Refunds go out within ten working days.", new_string: "Refunds go out within five working days.", status: "pending", review: "review" },
            ],
          });
        },
      }),
    };
    const found = await nodeBackend(agentOf("liv")).searchDocs({ q: "refund approval" });
    if ("error" in found) throw new Error(found.error);
    expect(found.results.find((r) => r.doc_id === "d_refunds")).toMatchObject({
      // A label an older version recorded for an agent names no one, and is left out.
      last_edited_by: [
        { kind: "person", name: "Liv" },
        { kind: "agent", name: "Sam's agent" },
        { kind: "agent", name: "Liv's AI co-author" },
      ],
      ai_edits: "unreviewed",
      pending_changes: [
        {
          asked_by: "user",
          waits_for: "review",
          changes: 1,
          since: "2026-10-21T09:00:00.000Z",
          proposed: [{ approved_now: "Refunds go out within ten working days.", after_approval: "Refunds go out within five working days." }],
        },
        { asked_by: "others", waits_for: "colleague", changes: 2, since: "2026-10-20T09:00:00.000Z" },
      ],
    });
    // Only Liv's own run is read, with the approved text; Dee's is counted.
    expect(asked.filter((url) => url.includes("/runs/detail"))).toEqual([expect.stringContaining("runId=run_3")]);
    delete env.docs;
    await sql`DELETE FROM agent_runs WHERE run_id = 'run_3'`;
    const passages = await nodeBackend(agentOf("liv")).retrieve({ q: "refund approval" });
    if ("error" in passages) throw new Error(passages.error);
    // Embeddings are off here: an agent still gets passages, found by their words.
    expect(passages).toMatchObject({ keyword_only: true });
    expect(passages.chunks.find((c) => c.doc_id === "d_refunds")).toMatchObject({ pending_changes: [{ waits_for: "colleague", changes: 2 }] });
    expect(found.results.find((r) => r.doc_id === "d_onboarding") ?? { ai_edits: "none" }).toMatchObject({ ai_edits: "none" });

    const person = { ...agentOf("liv"), isAgent: false, alias: "liv", onBehalfOf: undefined, principals: ["user:liv", ORG] } as unknown as Ctx;
    const rest = await searchDocuments(person, { q: "refund approval" });
    if (rest === "not-found") throw new Error("not found");
    for (const hit of rest.results) {
      expect(hit).not.toHaveProperty("last_edited_by");
      expect(hit).not.toHaveProperty("ai_edits");
      expect(hit).not.toHaveProperty("pending_changes");
      expect(hit).not.toHaveProperty("kw_whole");
    }
    await sql`DELETE FROM agent_runs WHERE run_id = 'run_2'`;
  });

  it("finds for an agent the pages holding some of a sentence's words when none holds them all, and says so", async () => {
    const q = "refund approval paperwork zeppelin";
    const agent = await nodeBackend(agentOf("liv")).searchDocs({ q });
    if ("error" in agent) throw new Error(agent.error);
    expect(agent.partial).toBe(true);
    expect(agent.results.map((r) => r.doc_id)).toContain("d_refunds");
    const person = { ...agentOf("liv"), isAgent: false, alias: "liv", onBehalfOf: undefined, principals: ["user:liv", ORG] } as unknown as Ctx;
    const rest = await searchDocuments(person, { q });
    if (rest === "not-found") throw new Error("not found");
    expect(rest).toEqual({ query: q, results: [], degraded: false, semantic: false });
  });

  describe("what a plan says is there already, and where a new page goes", () => {
    beforeAll(async () => {
      await folder("f_customers", "Customers", {
        mode: "colleague",
        instructions: "One page per customer, titled with the customer's name. Facts go under ## Facts or ## Contract.",
      });
      await page("d_acme", "Acme", [["Contract", "Annual contract that renews on 1 March. Invoices are paid net 30."]], { parentId: "f_customers" });
      await page("d_expenses", "Expense limits", [["Receipts", "Expenses over 200 euros need a receipt. Expenses over 900 euros need a receipt and approval from Sam."]], {
        parentId: "f_support",
      });
      await page("d_faq", "Refund questions", [["FAQ", "Do refunds over 700 euros need a second signature? No: since March only refunds over 2000 euros do."]], {
        parentId: "f_support",
      });
      const home = (await planRemember(agentOf("liv"), [{ text: "x" }])).home!;
      await page("d_prefs", "Writing preferences", [[null, "Prefers British spelling in documents. Said by the user on 2026-10-22."]], {
        parentId: home.folder_id,
        readers: ["user:liv"],
        writers: ["user:liv"],
      });
    });

    it("says whom the connection acts for, by their Stuga name, and echoes each point's source", async () => {
      const plan = await planRemember(agentOf("liv"), [{ text: "Acme renews on 1 March each year.", topic: "Acme", source: "chat with Liv" }]);
      expect(plan.user).toEqual({ name: "Liv", username: "liv" });
      expect(plan.points[0]).toMatchObject({ source: "chat with Liv" });
      expect((await planRemember(agentOf("liv"), [{ text: "Acme renews on 1 March each year." }])).points[0]!.source).toBeNull();
    });

    it("decides what is already there sentence by sentence, and still names the page's other sentences the point may change", async () => {
      const plan = await planRemember(agentOf("liv"), [{ text: "Expenses over 200 euros need a receipt.", topic: "Expenses" }]);
      const [point] = plan.points;
      expect(point!.already_saved).toEqual([expect.objectContaining({ doc_id: "d_expenses", sentence: "Expenses over 200 euros need a receipt." })]);
      expect(point!.possibly_replaces).toContainEqual(
        expect.objectContaining({ doc_id: "d_expenses", sentence: "Expenses over 900 euros need a receipt and approval from Sam.", hint: "possibly_replaces" }),
      );
      expect(point!.possibly_replaces.map((r) => r.sentence)).not.toContain("Expenses over 200 euros need a receipt.");

      // A question is not the point said, though it names its words: it is a sentence the point may change.
      const faq = (await planRemember(agentOf("liv"), [{ text: "Refunds over 700 euros need a second signature." }])).points[0]!;
      expect(faq.already_saved.map((a) => a.doc_id)).not.toContain("d_faq");
      expect(faq.possibly_replaces).toContainEqual(expect.objectContaining({ doc_id: "d_faq", sentence: "Do refunds over 700 euros need a second signature?" }));
    });

    it("calls a sentence with the point's figures in other words a likely duplicate, and never matches on a date alone", async () => {
      const plan = await planRemember(agentOf("liv"), [{ text: "Acme pays our invoices within 30 days (net 30).", topic: "Acme" }]);
      const [point] = plan.points;
      expect(point!.candidates[0]).toMatchObject({ kind: "page", doc_id: "d_acme", section: "Contract", review: { mode: "colleague" } });
      expect(point!.possibly_replaces).toContainEqual(expect.objectContaining({ doc_id: "d_acme", sentence: "Invoices are paid net 30.", hint: "likely_duplicate" }));

      const dated = (await planRemember(agentOf("liv"), [{ text: "Acme pays our invoices within 30 days. Noted on 2026-10-22." }])).points[0]!;
      expect(JSON.stringify(dated)).not.toContain("d_prefs");
    });

    it("offers a folder whose name fits for a new page when no page is about the point, and never says a keyword match is close in meaning", async () => {
      const plan = await planRemember(agentOf("liv"), [{ text: "Initech is a new customer, and Ana Ruiz is their contact.", topic: "Initech" }]);
      const [point] = plan.points;
      expect(point!.candidates[0]).toEqual({
        kind: "new_page",
        folder_id: "f_customers",
        folder_path: ["Customers"],
        why: expect.stringContaining('its name "Customers" fits'),
        review: { mode: "colleague", reason: "this document waits for a colleague's approval" },
        instructions_labels: ['Folder "Customers"'],
      });
      // A folder holding a page about the point is no place for another.
      const acme = (await planRemember(agentOf("liv"), [{ text: "Acme, our customer, pays net 45 from April.", topic: "Acme" }])).points[0]!;
      expect(acme.candidates.filter((c) => c.kind === "new_page").map((c) => c.folder_id)).not.toContain("f_customers");
      expect(acme.candidates[0]).toMatchObject({ kind: "page", doc_id: "d_acme" });
      for (const c of [...point!.candidates, ...acme.candidates]) expect(c.why).not.toContain("close in meaning");
    });

    it("says a page on a point may be written in another language when only words were matched and no page is about it", async () => {
      await folder("f_onboarding", "Onboarding", { instructions: "Pages may be in English or Chinese: add to a page in the language it is written in." });
      await page("d_xinyuangong", "新员工须知", [["办公室", "上海办公室在静安区，前台早上 9 点开门。"]], { parentId: "f_onboarding" });
      // Eval run 3, #13: the chat's point written in English reaches no word of the Chinese page.
      const english = (await planRemember(agentOf("liv"), [{ text: "Shanghai office reception now opens at 8:30 a.m.", topic: "Shanghai office hours" }])).points[0]!;
      expect(JSON.stringify(english.candidates)).not.toContain("d_xinyuangong");
      expect(english.note).toBe(OTHER_LANGUAGE_NOTE);
      expect(english.note).toContain("another language");
      // In the chat's own language, the plan finds the page, and says nothing of other languages.
      const chinese = (await planRemember(agentOf("liv"), [{ text: "上海办公室前台现在早上 8 点半开门。", topic: "上海办公室" }])).points[0]!;
      expect(chinese.candidates[0]).toMatchObject({ kind: "page", doc_id: "d_xinyuangong", section: "办公室" });
      expect(chinese).not.toHaveProperty("note");
      // A page about the point needs no word on languages either.
      const refunds = (await planRemember(agentOf("liv"), [{ text: "Refunds over 300 euros need finance approval.", topic: "Refunds" }])).points[0]!;
      expect(refunds).not.toHaveProperty("note");
    });

    it("offers My notes pages only when nothing of the wiki is about the point", async () => {
      const team = (await planRemember(agentOf("liv"), [{ text: "Acme documents are written in British spelling.", topic: "Acme" }])).points[0]!;
      expect(team.candidates[0]).toMatchObject({ doc_id: "d_acme" });
      expect(team.candidates.map(idOf)).not.toContain("d_prefs");
      const own = (await planRemember(agentOf("liv"), [{ text: "I prefer British spelling in documents.", topic: "Writing preferences" }])).points[0]!;
      expect(own.candidates[0]).toMatchObject({ doc_id: "d_prefs", in_my_notes: true });
    });

    it("reports the level the caller's own write gets: a person's at review, and whether My notes is shared", async () => {
      const person = { ...agentOf("liv"), isAgent: false, alias: "liv", onBehalfOf: undefined, principals: ["user:liv", ORG] } as unknown as Ctx;
      const plan = await planRemember(person, [{ text: "Refunds over 300 euros need finance approval.", topic: "Refunds" }]);
      expect(plan.points[0]!.candidates[0]).toMatchObject({ doc_id: "d_refunds", review: { mode: "review", reason: "a human session" } });
      expect(plan.home).toMatchObject({ shared: false, review: { mode: "review", reason: "a human session" } });

      const home = plan.home!.folder_id;
      await sql`UPDATE folders SET acl_principals = ${["user:liv", ORG]} WHERE folder_id = ${home}`;
      try {
        // Shared, it is no longer the person's alone: an agent's write there waits for review.
        expect((await planRemember(agentOf("liv"), [{ text: "x" }])).home).toMatchObject({ shared: true, review: { mode: "review" } });
      } finally {
        await sql`UPDATE folders SET acl_principals = ${["user:liv"]} WHERE folder_id = ${home}`;
      }
    });
  });

  describe("a team wiki indexed as a flush indexes it", () => {
    const NW = "ws-northwind";
    const NW_ORG = `org:${NW}`;
    const nw = (who: string): Ctx => agentOf(who, { workspaceId: NW, principals: [`agent:agent-${who}`, `user:${who}`, NW_ORG] });

    async function nwFolder(folderId: string, title: string, instructions: string, mode?: string) {
      await createFolder(sql, { folderId, workspaceId: NW, owner: "user:liv", title, aclPrincipals: ["user:liv", NW_ORG], aclWriters: ["user:liv", NW_ORG], agentInstructions: instructions });
      if (mode) await sql`UPDATE folders SET agent_mode = ${mode} WHERE folder_id = ${folderId}`;
    }

    /** A page as the index job writes it: its Markdown, one passage per section, none of headings alone. */
    async function nwPage(docId: string, title: string, markdown: string, parentId: string, createdBy?: string) {
      await createDoc(sql, {
        docId,
        workspaceId: NW,
        owner: "user:liv",
        title,
        parentId,
        aclPrincipals: ["user:liv", NW_ORG],
        aclWriters: ["user:liv", NW_ORG],
        ...(createdBy ? { createdBy } : {}),
      });
      const pieces = markdown === "" ? [] : headingAwareChunk(markdown);
      await indexDoc(sql, {
        embeddingDims: EMBEDDING_DIMS,
        docId,
        snapshotSeq: 1,
        title,
        searchText: markdown,
        embeddingHash: `h-${docId}`,
        chunks: pieces.map((p, i) => ({ content: p.content, headingPath: p.headingPath, embedding: null, embedHash: `${docId}-${i}` })),
      });
    }

    beforeAll(async () => {
      await provisionWorkspace(sql, { workspaceId: NW, name: "Northwind", owner: "liv", defaultDocAccess: "workspace_edit" });
      await sql`INSERT INTO workspace_members (workspace_id, alias, role) VALUES (${NW}, 'sam', 'member')`;
      await nwFolder(
        "nw_customers",
        "Customers",
        'One page per customer, titled with the customer\'s name (for example "Acme"). Facts go under ## Facts or ## Contract, people under ## Contacts.',
        "colleague",
      );
      await nwFolder("nw_policies", "Policies", "One page per policy (Refunds, Travel, ...). Rules go under ## Rules as short bullet points.", "colleague");
      await nwFolder("nw_onboarding", "Onboarding", "What a new hire needs in their first weeks. Pages may be in English or Chinese.");
      await nwPage(
        "nw_acme",
        "Acme",
        "# Acme\n\nAcme Corp is a logistics company in Rotterdam and our largest customer since 2024.\n\n## Contacts\n\n- Jonas Weber, head of operations, is the main contact.\n\n## Contract\n\n- Annual contract that renews on 1 March.\n- The refund window is 14 days from delivery.\n- Invoices are paid net 30.\n",
        "nw_customers",
      );
      await nwPage(
        "nw_globex",
        "Globex",
        "# Globex\n\nGlobex is a manufacturing group in Lyon and a customer since 2025.\n\n## Contacts\n\n- Priya Shah, procurement lead, is the main contact.\n\n## Contract\n\n- Monthly contract, cancelled with 30 days' notice.\n- The refund window is 7 days from delivery.\n\n## Facts\n\n- Globex prefers email to phone calls.\n",
        "nw_customers",
      );
      // Made by Liv's agent, its text all waiting for a colleague: nothing of it approved, so nothing indexed but its title.
      await nwPage("nw_initech", "Initech", "", "nw_customers", "agent:agent-liv");
      await nwPage(
        "nw_refunds",
        "Refunds",
        "# Refunds\n\n## Rules\n\n- Refunds over $500 need a manager's approval before they are sent.\n- Refunds go back to the original payment method.\n- Each customer's refund window is on their page in Customers.\n",
        "nw_policies",
      );
      await nwPage(
        "nw_windows",
        "Refund windows",
        "# Refund windows\n\n## By customer\n\n- Acme's refund window is 14 days.\n- Globex's refund window is 7 days.\n",
        "nw_policies",
      );
      await nwPage(
        "nw_travel",
        "Travel",
        "# Travel\n\n## Rules\n\n- Book economy class for flights under 6 hours.\n- Hotels cost at most €150 a night in Europe.\n- Submit the expense report within 30 days of the trip, with receipts.\n\n## Booking\n\n- Book flights and hotels through the travel desk at travel@northwind.example.\n",
        "nw_policies",
      );
      await nwPage(
        "nw_first",
        "First week",
        "# First week\n\n## Accounts\n\n- IT sets up the laptop and email on the first day.\n\n## People\n\n- Every new hire gets a buddy from their own team.\n",
        "nw_onboarding",
      );
      await nwPage("nw_xinyuan", "新员工须知", "# 新员工须知\n\n## 办公室\n\n- 上海办公室在静安区，前台早上 9 点开门。\n\n## 报销\n\n- 市内交通费每月底统一报销。\n", "nw_onboarding");
    });

    it("never offers a page's title heading as a section, and finds no passage in a heading alone", async () => {
      const chunks = await sql<{ heading_path: string | null; content: string }[]>`SELECT heading_path, content FROM doc_chunks WHERE doc_id = 'nw_xinyuan' ORDER BY chunk_index`;
      expect(chunks.map((c) => c.heading_path)).toEqual(["新员工须知 > 办公室", "新员工须知 > 报销"]);
      const plan = await planRemember(nw("liv"), [
        { text: "新同事第一周不排夜班，先跟着 buddy 熟悉流程。", topic: "新员工入职", source: "群聊 2026-10-21" },
        { text: "上海办公室寄快递现在统一走顺丰，月结账号在前台。", topic: "上海办公室快递" },
      ]);
      const [shift, post] = plan.points;
      for (const c of [...shift!.candidates, ...post!.candidates]) {
        if (c.kind === "page") expect(c.section).not.toBe(c.title);
      }
      // The page its topic names, with no section to offer: none of its sections is about the point.
      expect(pagesOf(shift!).find((c) => c.doc_id === "nw_xinyuan")).toMatchObject({ section: null });
      // A rare word of the point is still a reason to look there.
      expect(pagesOf(shift!).find((c) => c.doc_id === "nw_first")).toMatchObject({ section: "People" });
      expect(pagesOf(post!)[0]).toMatchObject({ doc_id: "nw_xinyuan", section: "办公室", heading_path: "新员工须知 > 办公室" });
    });

    it("reaches a page whose approved text is empty by its title, first, and leaves out the pages beside it", async () => {
      const plan = await planRemember(nw("liv"), [
        { text: "Initech's contract starts on 1 November 2026.", topic: "Initech contract" },
        { text: "Initech invoices are paid net 45.", topic: "Initech contract" },
      ]);
      for (const point of plan.points) {
        expect(point.candidates[0]).toMatchObject({ kind: "page", doc_id: "nw_initech", title: "Initech", section: null, excerpt: "" });
        expect(point.candidates[0]!.why).toContain("none of its text is approved yet");
        // Acme and Globex are other customers: no place for Initech's terms, and their sentences are not what these replace.
        const ids = point.candidates.map(idOf);
        expect(ids).not.toContain("nw_acme");
        expect(ids).not.toContain("nw_globex");
        expect(point.possibly_replaces.map((r) => r.doc_id)).not.toContain("nw_acme");
      }
      // A page found on one word, when the point names its own: left out ("payment", "days").
      const net = await planRemember(nw("liv"), [
        { text: "Initech's invoices are paid net 45, meaning payment is due 45 days after the invoice date.", topic: "Initech contract" },
      ]);
      expect(net.points[0]!.candidates.map(idOf)).toEqual(["nw_initech"]);
    });

    it("leaves out a page found by another form of the topic's word, by a word of an address, or by one common word", async () => {
      const plan = await planRemember(nw("liv"), [{ text: "Globex wants invoices sent to ap@globex.example.", topic: "Globex account" }]);
      expect(plan.points[0]!.candidates.map(idOf)).toEqual(["nw_globex"]);
      // With no page named, a word two pages hold is common: "contract" alone names neither customer's section.
      const unnamed = await planRemember(nw("liv"), [{ text: "The new supplier's contract starts in spring.", topic: "Supplier contract" }]);
      expect(unnamed.points[0]!.candidates.map(idOf)).not.toEqual(expect.arrayContaining(["nw_acme"]));
      expect(unnamed.points[0]!.candidates.map(idOf)).not.toEqual(expect.arrayContaining(["nw_globex"]));
    });

    it("never names a sentence about another customer as one the point replaces", async () => {
      const plan = await planRemember(nw("liv"), [{ text: "Acme's refund window is now 30 days.", topic: "Acme refunds" }]);
      const sentences = plan.points[0]!.possibly_replaces.map((r) => `${r.doc_id}: ${r.sentence}`);
      expect(sentences).toContain("nw_acme: The refund window is 14 days from delivery.");
      expect(sentences).toContain("nw_windows: Acme's refund window is 14 days.");
      expect(sentences).not.toContain("nw_globex: The refund window is 7 days from delivery.");
      expect(sentences).not.toContain("nw_windows: Globex's refund window is 7 days.");
      expect(plan.points[0]!.candidates[0]).toMatchObject({ doc_id: "nw_acme", section: "Contract" });
    });

    it("puts a page that says the point already before any new page", async () => {
      const plan = await planRemember(nw("liv"), [{ text: "Every new hire gets a buddy from their own team. This is unchanged.", topic: "Onboarding" }]);
      const [point] = plan.points;
      expect(point!.possibly_replaces).toContainEqual(expect.objectContaining({ doc_id: "nw_first", hint: "likely_duplicate" }));
      expect(point!.candidates[0]).toMatchObject({ kind: "page", doc_id: "nw_first", section: "People" });
      expect(point!.candidates[0]!.why).toContain("it says the point already");
      expect(point!.candidates.filter((c) => c.kind === "new_page").map((c) => c.folder_id)).not.toContain("nw_onboarding");
    });

    it("says a keyword retrieve matched only some of the question's words, and names who made a page with nothing approved", async () => {
      const backend = nodeBackend(nw("liv"));
      const some = await backend.retrieve({ q: "差旅报销" });
      if ("error" in some) throw new Error(some.error);
      expect(some).toMatchObject({ keyword_only: true, partial: true });
      expect(some.chunks.map((c) => c.heading_path)).toEqual(["新员工须知 > 报销"]);
      const all = await backend.retrieve({ q: "Acme refund window" });
      if ("error" in all) throw new Error(all.error);
      expect(all.partial).toBeUndefined();
      expect(all.chunks).toContainEqual(expect.objectContaining({ doc_id: "nw_acme", heading_path: "Acme > Contract" }));
      // No passage is a heading alone.
      for (const c of [...some.chunks, ...all.chunks]) expect(c.content).toMatch(/\n[^#\s]/);

      await sql`INSERT INTO api_keys (key_id, secret_hash, agent_id, owner, workspace_id, name) VALUES ('k_nw_liv', 'x', 'agent-liv', 'liv', ${NW}, 'Claude')`;
      const found = await backend.searchDocs({ q: "Initech" });
      if ("error" in found) throw new Error(found.error);
      expect(found.results.find((r) => r.doc_id === "nw_initech")).toMatchObject({ last_edited_by: [{ kind: "agent", name: "Liv's agent" }] });
    });
  });
});
