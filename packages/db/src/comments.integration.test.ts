import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, updateDoc } from "./docs.js";
import { addComment, importComments, listComments, listDocsWithCommentsOver, deleteComment, syncDocMentions } from "./comments.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("comment threads", () => {
  let sql: Sql;
  const WS = "ws-test";

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS);
  });

  it("a root keeps its anchor; a reply stores parent_num and drops its anchor", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    const root = await addComment(sql, {
      docId: "d1",
      author: "alice",
      body: "root",
      anchorStart: "S",
      anchorEnd: "E",
      anchorQuote: "quoted",
    });
    expect(root.num).toBe(1);
    expect(root.parent_num).toBeNull();
    expect(root.anchor_quote).toBe("quoted");

    const reply = await addComment(sql, {
      docId: "d1",
      author: "bob",
      body: "reply",
      parentNum: root.num,
      anchorStart: "X",
      anchorEnd: "Y",
      anchorQuote: "should be dropped",
    });
    expect(reply.num).toBe(2);
    expect(reply.parent_num).toBe(root.num);
    expect(reply.anchor_start).toBeNull();
    expect(reply.anchor_end).toBeNull();
    expect(reply.anchor_quote).toBeNull();
    expect(typeof reply.parent_num).toBe("number");
  });

  it("stores the mentions a comment resolved to, and defaults to none", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    const plain = await addComment(sql, { docId: "d1", author: "alice", body: "no one" });
    expect(plain.mentions).toEqual([]);
    const tagged = await addComment(sql, {
      docId: "d1",
      author: "alice",
      body: "@bob look",
      mentions: [{ alias: "u_bob", username: "bob" }],
    });
    expect(tagged.mentions).toEqual([{ alias: "u_bob", username: "bob" }]);
    expect((await listComments(sql, "d1"))[1]!.mentions).toEqual([{ alias: "u_bob", username: "bob" }]);
  });

  it("syncDocMentions reports only people newly mentioned, and forgets removed ones", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    expect(await syncDocMentions(sql, "d1", ["u_bob", "u_cy"])).toEqual(["u_bob", "u_cy"]);
    expect(await syncDocMentions(sql, "d1", ["u_cy", "u_bob"])).toEqual([]);
    expect(await syncDocMentions(sql, "d1", ["u_cy"])).toEqual([]);
    // Mentioned again after removal: new again.
    expect(await syncDocMentions(sql, "d1", ["u_bob", "u_cy"])).toEqual(["u_bob"]);
    expect(await syncDocMentions(sql, "d1", [])).toEqual([]);
    expect(await syncDocMentions(sql, "d1", ["u_cy"])).toEqual(["u_cy"]);
  });

  it("syncDocMentions lets one of two racing saves report a new mention", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    const [a, b] = await Promise.all([syncDocMentions(sql, "d1", ["u_bob"]), syncDocMentions(sql, "d1", ["u_bob"])]);
    expect([...a!, ...b!]).toEqual(["u_bob"]);
  });

  it("deleting a root deletes its replies", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d2", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    const root = await addComment(sql, { docId: "d2", author: "alice", body: "root" });
    await addComment(sql, { docId: "d2", author: "bob", body: "r1", parentNum: root.num });
    await addComment(sql, { docId: "d2", author: "carol", body: "reply-2", parentNum: root.num });
    expect(await listComments(sql, "d2")).toHaveLength(3);

    const deleted = await deleteComment(sql, "d2", root.num);
    expect(deleted).toBe(true);
    expect(await listComments(sql, "d2")).toHaveLength(0);
  });

  it("deleting one reply leaves the root and sibling replies intact", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d3", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    const root = await addComment(sql, { docId: "d3", author: "alice", body: "root" });
    const r1 = await addComment(sql, { docId: "d3", author: "bob", body: "r1", parentNum: root.num });
    await addComment(sql, { docId: "d3", author: "carol", body: "reply-2", parentNum: root.num });

    await deleteComment(sql, "d3", r1.num);
    const rows = await listComments(sql, "d3");
    expect(rows.map((c) => c.num).sort((a, b) => a - b)).toEqual([root.num, 3]);
  });
  it("imports comments after the ones a document has, keeping times, threads, resolution and quotes", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d4", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    await addComment(sql, { docId: "d4", author: "alice", body: "already here" });
    await importComments(sql, "d4", [
      { num: 7, parentNum: null, authorName: "Liv", body: "Is this the final wording?", anchorQuote: "final", resolved: true, createdAt: "2026-03-01T09:30:00Z" },
      { num: 9, parentNum: 7, authorName: "Editor", body: "Yes.", anchorQuote: "ignored on a reply", resolved: false, createdAt: "2026-03-02T10:00:00+02:00" },
      { num: 12, parentNum: null, authorName: "Liv", body: "Unanchored.", anchorQuote: null, resolved: false, createdAt: "1999-12-31T23:59:59.5Z" },
    ]);
    const rows = await listComments(sql, "d4");
    expect(rows.map((c) => [c.num, c.parent_num, c.author, c.anchor_quote, c.resolved])).toEqual([
      [1, null, "alice", null, false],
      [2, null, "imported:Liv", "final", true],
      [3, 2, "imported:Editor", null, false],
      [4, null, "imported:Liv", null, false],
    ]);
    expect(new Date(rows[1]!.created_at).toISOString()).toBe("2026-03-01T09:30:00.000Z");
    expect(new Date(rows[2]!.created_at).toISOString()).toBe("2026-03-02T08:00:00.000Z");
    expect(new Date(rows[3]!.updated_at).toISOString()).toBe("1999-12-31T23:59:59.500Z");
    expect(rows.slice(1).every((c) => c.mentions.length === 0 && c.anchor_start === null && c.anchor_end === null)).toBe(true);
    // The next comment someone writes follows them.
    expect((await addComment(sql, { docId: "d4", author: "alice", body: "next" })).num).toBe(5);
  });

  it("imports nothing when a reply names a thread that is not before it", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d5", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    await expect(
      importComments(sql, "d5", [
        { num: 1, parentNum: 2, authorName: "Liv", body: "early reply", anchorQuote: null, resolved: false, createdAt: "2026-03-01T09:30:00Z" },
        { num: 2, parentNum: null, authorName: "Liv", body: "root", anchorQuote: null, resolved: false, createdAt: "2026-03-01T09:30:00Z" },
      ]),
    ).rejects.toThrow(/not before it/);
    expect(await listComments(sql, "d5")).toEqual([]);
  });

  it("names the workspace's live documents with more comments than a cap, and how many", async () => {
    await seedWorkspaces(sql, "ws-other");
    const doc = async (docId: string, comments: number, ws = WS) => {
      await createDoc(sql, { workspaceId: ws, docId, owner: "user:alice", title: docId, aclPrincipals: ["user:alice"] });
      for (let i = 0; i < comments; i++) await addComment(sql, { docId, author: "alice", body: `c${i}` });
    };
    await doc("busy", 3);
    await doc("quiet", 2);
    await doc("trashed", 3);
    await updateDoc(sql, "trashed", { trashed: true });
    await doc("elsewhere", 3, "ws-other");
    expect(await listDocsWithCommentsOver(sql, WS, 2)).toEqual([{ doc_id: "busy", comments: 3 }]);
    expect(await listDocsWithCommentsOver(sql, WS, 3)).toEqual([]);
  });
});
