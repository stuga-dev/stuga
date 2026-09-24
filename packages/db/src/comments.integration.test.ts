import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc } from "./docs.js";
import { addComment, listComments, deleteComment, syncDocMentions } from "./comments.js";
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
});
