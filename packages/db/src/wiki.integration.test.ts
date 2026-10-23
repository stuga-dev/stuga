/**
 * The wiki's links kept in step with each page's approved text (syncDocWiki), and everything read
 * from them, always as one reader can read the workspace: the pages linking to a page, the citations
 * that need checking, the Index, orphans, broken links and the Log. Nothing names or counts a page,
 * a folder or a change the reader cannot open, and a page a change holds is not the wiki's yet.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClients, createClient, type Sql } from "./client.js";
import { createDoc, updateDoc } from "./docs.js";
import { createFolder, createHomeFolder } from "./folders.js";
import { createChange, holdChangePage } from "./changes.js";
import { upsertAgentRun } from "./governance.js";
import { initSchema } from "./schema/migrate.js";
import { seedUser, seedWorkspaces } from "./testing/fixtures.js";
import {
  brokenLinks,
  indexPages,
  logEntries,
  markCitationsChecked,
  orphanPages,
  pagesLinkingTo,
  readableFolders,
  staleCitations,
  stalePages,
  syncDocWiki,
  type DocWikiSync,
  type WikiReader,
} from "./wiki.js";
import type { RunIndexEntry } from "@stuga/protocol/internal/jobs";

const URL = process.env.TEST_DATABASE_URL;
const WS = "ws-wiki";
const ORG = `org:${WS}`;
const liv: WikiReader = { workspaceId: WS, principals: ["user:wkliv", ORG], scopeFolderIds: null };
const sam: WikiReader = { workspaceId: WS, principals: ["user:wksam", ORG], scopeFolderIds: null };
const ALL = { folderIds: null, limit: 100 };

describe.skipIf(!URL)("the wiki", () => {
  let sql: Sql;
  let seq = 0;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  /** The links a page's text holds now, as the index job reads them: one snapshot later each time. */
  const sync = (docId: string, links: Array<[string, "link" | "citation", string?]>, over: Partial<DocWikiSync> = {}) =>
    syncDocWiki(sql, {
      docId,
      seq: ++seq,
      textHash: over.textHash ?? `text-${seq}`,
      summary: `About ${docId}`,
      editors: ["wkliv"],
      links: links.map(([target, kind, context]) => ({ target, kind, contextHash: context ?? `ctx-${target}` })),
      ...over,
    });

  const page = (docId: string, title: string, parentId: string | null, readers = ["user:wkliv", ORG]) =>
    createDoc(sql, { workspaceId: WS, docId, owner: "user:wkliv", title, parentId, aclPrincipals: readers, aclWriters: readers });

  /** Text that changed `minutes` ago, so what cites it can be approved before or after. */
  const changedAgo = (docId: string, minutes: number) =>
    sql`UPDATE docs SET text_changed_at = now() - make_interval(mins => ${minutes}) WHERE doc_id = ${docId}`;
  const checkedAgo = (docId: string, minutes: number) =>
    sql`UPDATE doc_links SET checked_at = now() - make_interval(mins => ${minutes}) WHERE doc_id = ${docId}`;

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await sql`TRUNCATE folders CASCADE`;
    await sql`DELETE FROM agent_runs WHERE workspace_id = ${WS}`;
    await sql`DELETE FROM wiki_changes WHERE workspace_id = ${WS}`;
    await sql`DELETE FROM users WHERE alias IN ('wkliv', 'wksam')`;
    await seedWorkspaces(sql, WS);
    await seedUser(sql, "wkliv", "Liv", null, "wiki-liv");
    await seedUser(sql, "wksam", "Sam", null, "wiki-sam");
    // Team pages everyone reads; Liv's private folder; Liv's My notes.
    await createFolder(sql, { workspaceId: WS, folderId: "f_team", owner: "user:wkliv", title: "Team", aclPrincipals: ["user:wkliv", ORG] });
    await createFolder(sql, { workspaceId: WS, folderId: "f_secret", owner: "user:wkliv", title: "Board", aclPrincipals: ["user:wkliv"] });
    await createHomeFolder(sql, { folderId: "f_notes", workspaceId: WS, alias: "wkliv", title: "My notes" });
    await page("d_top", "Welcome", null);
    await page("d_policy", "Refund policy", "f_team");
    await page("d_support", "Support", "f_team");
    await page("d_orphan", "Old notes", "f_team");
    await page("d_secret", "Merger plan", "f_secret", ["user:wkliv"]);
    await page("d_note", "Trips", "f_notes", ["user:wkliv"]);
  });

  describe("upkeep", () => {
    it("keeps one row per page and kind, drops links the text lost and a page's link to itself", async () => {
      expect(await sync("d_support", [["d_policy", "link"], ["d_policy", "citation"], ["d_support", "link"], ["d_top", "link"]])).toBe(true);
      const rows = () => sql<{ target_doc_id: string; kind: string }[]>`SELECT target_doc_id, kind FROM doc_links WHERE doc_id = 'd_support' ORDER BY 1, 2`;
      expect(await rows()).toEqual([
        { target_doc_id: "d_policy", kind: "citation" },
        { target_doc_id: "d_policy", kind: "link" },
        { target_doc_id: "d_top", kind: "link" },
      ]);
      await sync("d_support", [["d_policy", "citation"]]);
      expect(await rows()).toEqual([{ target_doc_id: "d_policy", kind: "citation" }]);
      await sync("d_support", []);
      expect(await rows()).toEqual([]);
    });

    it("moves when the text last changed, and who changed it, only when the text did; an older snapshot loses", async () => {
      await sync("d_policy", [], { textHash: "a", editors: ["wkliv", "agent-x"] });
      const read = async () => (await sql<{ text_changed_at: Date; text_changed_by: string[]; summary: string; links_seq: string }[]>`
        SELECT text_changed_at, text_changed_by, summary, links_seq FROM docs WHERE doc_id = 'd_policy'`)[0]!;
      const first = await read();
      expect(first.text_changed_by).toEqual(["wkliv", "agent-x"]);
      expect(first.summary).toBe("About d_policy");
      await changedAgo("d_policy", 10);
      // The same text again (a flush that changed nothing of it) leaves when and who alone.
      expect(await sync("d_policy", [], { textHash: "a", editors: ["wksam"] })).toBe(false);
      const same = await read();
      expect(same.text_changed_by).toEqual(["wkliv", "agent-x"]);
      expect(Number(same.links_seq)).toBe(seq);
      // A snapshot older than the one the row holds changes nothing.
      expect(await syncDocWiki(sql, { docId: "d_policy", seq: 1, textHash: "old", summary: "old", editors: [], links: [] })).toBe(false);
      expect((await read()).summary).toBe("About d_policy");
    });

    it("takes a page's first words as what the pages already citing it cite, whichever is indexed first", async () => {
      // The citing page first, as an import, or a change of several pages approved at once, can index it.
      await sync("d_support", [["d_policy", "citation"]]);
      await checkedAgo("d_support", 1);
      await sync("d_policy", []);
      expect(await staleCitations(sql, liv, ["d_support"])).toEqual([]);
      // Its next words are a change.
      await checkedAgo("d_support", 1);
      await sync("d_policy", []);
      expect((await staleCitations(sql, liv, ["d_support"])).map((c) => c.source_id)).toEqual(["d_policy"]);
    });

    it("keeps a citation of the words an emptied page lost to check once it gets new ones", async () => {
      const EMPTY = createHash("sha256").update("").digest("hex");
      await sync("d_policy", []);
      await changedAgo("d_policy", 30);
      await sync("d_support", [["d_policy", "citation"]]);
      await checkedAgo("d_support", 20);
      // Emptied ten minutes ago; a page cited it since, as a page cites an empty one.
      await sync("d_policy", [], { textHash: EMPTY });
      await changedAgo("d_policy", 10);
      await sync("d_top", [["d_policy", "citation"]]);
      await checkedAgo("d_top", 5);
      await sync("d_policy", []);
      expect((await staleCitations(sql, liv, ["d_support", "d_top"])).map((c) => c.doc_id)).toEqual(["d_support"]);
    });

    it("approves a link again when the passages holding it change, and only then", async () => {
      await sync("d_support", [["d_policy", "citation", "p1"]]);
      await checkedAgo("d_support", 60);
      const checked = async () => (await sql<{ checked_at: Date }[]>`SELECT checked_at FROM doc_links WHERE doc_id = 'd_support'`)[0]!.checked_at.getTime();
      const before = await checked();
      // Text changed elsewhere on the page: the citation's passages are as they were.
      await sync("d_support", [["d_policy", "citation", "p1"]]);
      expect(await checked()).toBe(before);
      await sync("d_support", [["d_policy", "citation", "p2"]]);
      expect(await checked()).toBeGreaterThan(before);
    });
  });

  describe("what links to a page", () => {
    beforeEach(async () => {
      await sync("d_support", [["d_policy", "link"], ["d_policy", "citation"]]);
      await sync("d_secret", [["d_policy", "link"]]);
    });

    it("names only the pages the reader opens, and nothing of the others", async () => {
      expect(await pagesLinkingTo(sql, sam, "d_policy")).toEqual([
        { doc_id: "d_support", title: "Support", doc_type: "prose", parent_id: "f_team", kinds: ["citation", "link"] },
      ]);
      expect((await pagesLinkingTo(sql, liv, "d_policy")).map((p) => p.title)).toEqual(["Merger plan", "Support"]);
    });

    it("leaves out a page in the trash, and one a change holds, until it is back or approved", async () => {
      await updateDoc(sql, "d_support", { trashed: true });
      expect(await pagesLinkingTo(sql, sam, "d_policy")).toEqual([]);
      await updateDoc(sql, "d_support", { trashed: false });
      await createChange(sql, { changeId: "chg_wk", workspaceId: WS, title: "Sync", summary: "", agent: "Claude", agentAlias: "agent-wk", onBehalfOf: "wkliv", client: null, model: null });
      await holdChangePage(sql, { docId: "d_support", changeId: "chg_wk", workspaceId: WS, heldGrants: [], releaseGrants: { p: [], w: [], c: [] }, reviewer: "wkliv", approverGroup: null });
      expect((await pagesLinkingTo(sql, liv, "d_policy")).map((p) => p.doc_id)).toEqual(["d_secret"]);
      await sql`UPDATE wiki_change_pages SET state = 'released' WHERE doc_id = 'd_support'`;
      expect((await pagesLinkingTo(sql, sam, "d_policy")).map((p) => p.doc_id)).toEqual(["d_support"]);
    });

    it("keeps a key confined to folders to them, and a page to its own workspace", async () => {
      const scoped = { ...liv, scopeFolderIds: ["f_secret"] };
      expect((await pagesLinkingTo(sql, scoped, "d_policy")).map((p) => p.doc_id)).toEqual(["d_secret"]);
      await seedWorkspaces(sql, "ws-wiki-other");
      expect(await pagesLinkingTo(sql, { ...liv, workspaceId: "ws-wiki-other" }, "d_policy")).toEqual([]);
    });
  });

  describe("needs checking", () => {
    beforeEach(async () => {
      await sync("d_policy", []);
      await sync("d_support", [["d_policy", "citation"]]);
      await checkedAgo("d_support", 60);
    });

    it("flags a citation whose source changed after it was approved, and not before", async () => {
      await changedAgo("d_policy", 120);
      expect(await staleCitations(sql, sam, ["d_support"])).toEqual([]);
      await changedAgo("d_policy", 5);
      expect(await staleCitations(sql, sam, ["d_support"])).toEqual([
        { doc_id: "d_support", source_id: "d_policy", source_title: "Refund policy", changed_at: expect.any(Date) },
      ]);
    });

    it("never tells a reader of a change to a page they cannot open", async () => {
      await changedAgo("d_policy", 5);
      await sql`UPDATE docs SET acl_principals = ${["user:wkliv"]} WHERE doc_id = 'd_policy'`;
      expect(await staleCitations(sql, sam, ["d_support"])).toEqual([]);
      expect((await indexPages(sql, sam, ALL)).pages.find((p) => p.doc_id === "d_support")!.needs_checking).toBe(false);
      expect((await stalePages(sql, sam, ALL)).pages).toEqual([]);
      expect((await stalePages(sql, liv, ALL)).pages.map((p) => p.doc_id)).toEqual(["d_support"]);
      // Nor does a reader's mark reach a citation of a page they cannot open.
      expect(await markCitationsChecked(sql, sam, "d_support")).toBe(0);
      expect(await staleCitations(sql, liv, ["d_support"])).toHaveLength(1);
      expect(await markCitationsChecked(sql, liv, "d_support")).toBe(1);
      expect(await staleCitations(sql, liv, ["d_support"])).toEqual([]);
    });

    it("never reads the citations of a page the reader cannot open", async () => {
      await sync("d_secret", [["d_policy", "citation"]]);
      await checkedAgo("d_secret", 60);
      await changedAgo("d_policy", 5);
      expect((await staleCitations(sql, sam, ["d_secret", "d_support"])).map((c) => c.doc_id)).toEqual(["d_support"]);
    });
  });

  describe("the Index", () => {
    it("lists the pages the reader opens by folder, with each summary and who changed it", async () => {
      await sync("d_policy", [], { editors: ["wksam"] });
      const { pages, truncated } = await indexPages(sql, sam, ALL);
      expect(truncated).toBe(false);
      expect(pages.map((p) => [p.parent_id, p.title])).toEqual([
        [null, "Welcome"],
        ["f_team", "Old notes"],
        ["f_team", "Refund policy"],
        ["f_team", "Support"],
      ]);
      const policy = pages.find((p) => p.doc_id === "d_policy")!;
      expect(policy).toMatchObject({ summary: "About d_policy", changed_by: ["wksam"], needs_checking: false });
      // A page with no approved text yet is named by who made it.
      expect(pages.find((p) => p.doc_id === "d_orphan")!.changed_by).toEqual(["wkliv"]);
    });

    it("leaves out row pages, pages in the trash and pages a change holds, and reads one folder at a time", async () => {
      await createDoc(sql, { workspaceId: WS, docId: "d_row", owner: "user:wkliv", title: "Row", parentId: "f_team", pageOf: "d_policy", pageRow: "t.r", aclPrincipals: [ORG] });
      await updateDoc(sql, "d_orphan", { trashed: true });
      await createChange(sql, { changeId: "chg_ix", workspaceId: WS, title: "x", summary: "", agent: "a", agentAlias: "agent-ix", onBehalfOf: "wkliv", client: null, model: null });
      await holdChangePage(sql, { docId: "d_support", changeId: "chg_ix", workspaceId: WS, heldGrants: [], releaseGrants: { p: [], w: [], c: [] }, reviewer: "wkliv", approverGroup: null });
      expect((await indexPages(sql, liv, ALL)).pages.map((p) => p.doc_id)).toEqual(["d_top", "d_note", "d_secret", "d_policy"]);
      expect((await indexPages(sql, liv, { folderIds: ["f_team"], limit: 10 })).pages.map((p) => p.doc_id)).toEqual(["d_policy"]);
      expect((await indexPages(sql, liv, { folderIds: [null], limit: 10 })).pages.map((p) => p.doc_id)).toEqual(["d_top"]);
      expect(await indexPages(sql, liv, { folderIds: null, limit: 2 })).toMatchObject({ truncated: true });
    });

    it("gives the folders the reader opens, and the My notes each is in", async () => {
      expect((await readableFolders(sql, sam)).map((f) => f.folder_id)).toEqual(["f_team"]);
      expect((await readableFolders(sql, liv)).find((f) => f.folder_id === "f_notes")!.home_of).toBe("wkliv");
    });
  });

  describe("orphans", () => {
    it("are pages in a folder that no other page the reader opens links to; the top level and My notes are none", async () => {
      await sync("d_top", [["d_support", "link"]]);
      await sync("d_support", [["d_policy", "citation"]]);
      expect((await orphanPages(sql, sam, ALL)).pages.map((p) => p.doc_id)).toEqual(["d_orphan"]);
      expect((await orphanPages(sql, liv, ALL)).pages.map((p) => p.doc_id)).toEqual(["d_secret", "d_orphan"]);
    });

    it("count only links the reader can see: a page only a private one links to is an orphan to everyone else", async () => {
      await sync("d_secret", [["d_orphan", "link"]]);
      expect((await orphanPages(sql, liv, ALL)).pages.map((p) => p.doc_id)).not.toContain("d_orphan");
      expect((await orphanPages(sql, sam, ALL)).pages.map((p) => p.doc_id)).toContain("d_orphan");
      // A link from a page in the trash links nothing.
      await sync("d_top", [["d_orphan", "link"]]);
      await updateDoc(sql, "d_top", { trashed: true });
      expect((await orphanPages(sql, sam, ALL)).pages.map((p) => p.doc_id)).toContain("d_orphan");
    });
  });

  describe("broken links", () => {
    beforeEach(async () => {
      await page("d_old", "Old policy", "f_team");
      await sync("d_support", [["d_missing", "link"], ["d_secret", "link"], ["d_old", "citation"], ["d_policy", "link"]]);
      await updateDoc(sql, "d_old", { trashed: true });
    });

    it("names a target in the trash the reader opens, and tells nothing apart of one gone or theirs not to open", async () => {
      const { links } = await brokenLinks(sql, sam, ALL);
      expect(links.map((l) => [l.target_doc_id, l.kind, l.in_trash, l.target_title])).toEqual([
        ["d_missing", "link", false, null],
        ["d_old", "citation", true, "Old policy"],
        ["d_secret", "link", false, null],
      ]);
      // Liv opens the private page: no link of hers to it is broken.
      expect((await brokenLinks(sql, liv, ALL)).links.map((l) => l.target_doc_id)).toEqual(["d_missing", "d_old"]);
    });

    it("never reads the links of a page the reader cannot open", async () => {
      await sync("d_secret", [["d_missing2", "link"]]);
      expect((await brokenLinks(sql, sam, ALL)).links.map((l) => l.doc_id)).not.toContain("d_secret");
      expect((await brokenLinks(sql, liv, { folderIds: ["f_secret"], limit: 10 })).links.map((l) => l.target_doc_id)).toEqual(["d_missing2"]);
    });
  });

  describe("the Log", () => {
    let at = Date.parse("2026-10-20T10:00:00Z");
    const run = (runId: string, docId: string, over: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
      runId,
      workspaceId: WS,
      docId,
      docKind: "prose",
      docTitle: "",
      source: "connector",
      agent: "Claude",
      agentAlias: "agent-wk",
      client: "claude-code",
      model: null,
      reviewer: "wkliv",
      status: "applied",
      reviewMode: "colleague",
      approverGroup: null,
      approvedBy: ["wksam"],
      decidedBy: ["wksam"],
      autoApplied: false,
      reverted: false,
      acknowledged: true,
      pending: 0,
      accepted: 1,
      rejected: 0,
      conflicts: 0,
      applied: 0,
      createdAt: at,
      updatedAt: (at += 60_000),
      ...over,
    });
    const link = (changeId: string, runId: string, docId: string) =>
      sql`INSERT INTO wiki_change_runs (change_id, doc_id, run_id, doc_kind) VALUES (${changeId}, ${docId}, ${runId}, 'prose')`;

    beforeEach(async () => {
      at = Date.parse("2026-10-20T10:00:00Z");
      await createChange(sql, { changeId: "chg_a", workspaceId: WS, title: "Customer sync", summary: "", agent: "Claude", agentAlias: "agent-wk", onBehalfOf: "wkliv", client: null, model: null });
      await upsertAgentRun(sql, run("run_a1", "d_policy"));
      await upsertAgentRun(sql, run("run_a2", "d_secret", { accepted: 0, rejected: 2 }));
      await link("chg_a", "run_a1", "d_policy");
      await link("chg_a", "run_a2", "d_secret");
      await upsertAgentRun(sql, run("run_b", "d_support", { accepted: 0, rejected: 1, decidedBy: ["wkliv"], approvedBy: [] }));
      await upsertAgentRun(sql, run("run_w", "d_orphan", { status: "open", pending: 2, accepted: 0 }));
    });

    it("lists decided changes newest first, each change once with the pages the reader opens", async () => {
      const mine = await logEntries(sql, liv, { limit: 10 });
      expect(mine.entries.map((e) => [e.entry_id, e.runs.map((r) => r.doc_id)])).toEqual([
        ["run_b", ["d_support"]],
        ["chg_a", ["d_policy", "d_secret"]],
      ]);
      expect(mine.entries[1]!.runs[0]).toMatchObject({ title: "Refund policy", change_title: "Customer sync", decided_by: ["wksam"], accepted: 1 });
      // Sam reads the change by the page he opens, and nothing of the other.
      const his = await logEntries(sql, sam, { limit: 10 });
      expect(his.entries.map((e) => [e.entry_id, e.runs.map((r) => r.doc_id)])).toEqual([
        ["run_b", ["d_support"]],
        ["chg_a", ["d_policy"]],
      ]);
      expect(JSON.stringify(his)).not.toContain("d_secret");
    });

    it("leaves out what still waits, a change with a page still waiting, and pages in the trash or held", async () => {
      await upsertAgentRun(sql, run("run_a3", "d_top", { status: "open", pending: 1, accepted: 0 }));
      await link("chg_a", "run_a3", "d_top");
      expect((await logEntries(sql, sam, { limit: 10 })).entries.map((e) => e.entry_id)).toEqual(["run_b"]);
      // A page waiting that the reader cannot open keeps nothing out, and shows nowhere.
      await sql`UPDATE docs SET acl_principals = ${["user:wkliv"]} WHERE doc_id = 'd_top'`;
      expect((await logEntries(sql, sam, { limit: 10 })).entries.map((e) => e.entry_id)).toEqual(["run_b", "chg_a"]);
      await updateDoc(sql, "d_support", { trashed: true });
      expect((await logEntries(sql, sam, { limit: 10 })).entries.map((e) => e.entry_id)).toEqual(["chg_a"]);
    });

    it("pages back from a cursor", async () => {
      const first = await logEntries(sql, liv, { limit: 1 });
      expect(first.entries.map((e) => e.entry_id)).toEqual(["run_b"]);
      expect(first.next).toEqual({ at: first.entries[0]!.at, entryId: "run_b" });
      const second = await logEntries(sql, liv, { limit: 1, before: first.next });
      expect(second.entries.map((e) => e.entry_id)).toEqual(["chg_a"]);
      expect(second.next).toBeNull();
    });
  });
});
