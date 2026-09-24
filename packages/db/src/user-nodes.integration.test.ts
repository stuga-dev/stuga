import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients, type Sql } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { seedUser } from "./testing/fixtures.js";
import { addUserNode, listUserNodes, removeUserNode } from "./user-nodes.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("bookmarks to other nodes", () => {
  let sql: Sql;
  let n = 0;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users CASCADE`;
    await seedUser(sql, "u1", "Ada");
    await seedUser(sql, "u2", "Grace");
  });

  const add = (alias: string, origin: string, label = new globalThis.URL(origin).host, max = 50) =>
    addUserNode(sql, { id: `bm_${++n}`, alias, label, origin }, max);

  it("lists a person's bookmarks in the order they were added, and nobody else's", async () => {
    await add("u1", "https://b.example");
    await add("u1", "https://a.example", "Work");
    await add("u2", "https://c.example");
    expect((await listUserNodes(sql, "u1")).map((r) => [r.label, r.origin])).toEqual([
      ["b.example", "https://b.example"],
      ["Work", "https://a.example"],
    ]);
    expect((await listUserNodes(sql, "u2")).map((r) => r.origin)).toEqual(["https://c.example"]);
  });

  it("appends after the last one even when an earlier one was removed", async () => {
    const first = await add("u1", "https://a.example");
    await add("u1", "https://b.example");
    expect(first.ok && (await removeUserNode(sql, "u1", first.node.id))).toBe(true);
    await add("u1", "https://a.example");
    expect((await listUserNodes(sql, "u1")).map((r) => r.origin)).toEqual(["https://b.example", "https://a.example"]);
  });

  it("refuses an origin the person already has, while another person may add it", async () => {
    expect((await add("u1", "https://a.example")).ok).toBe(true);
    expect(await add("u1", "https://a.example", "Again")).toEqual({ ok: false, reason: "already_added" });
    expect((await add("u2", "https://a.example")).ok).toBe(true);
  });

  it("holds the cap, also against concurrent adds", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => add("u1", `https://n${i}.example`, "N", 5)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toEqual(Array(3).fill({ ok: false, reason: "limit_reached" }));
    const rows = await sql<{ position: number }[]>`SELECT position FROM user_nodes WHERE alias = 'u1' ORDER BY position`;
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("removes only the caller's own bookmark", async () => {
    const theirs = await add("u2", "https://a.example");
    if (!theirs.ok) throw new Error("add failed");
    expect(await removeUserNode(sql, "u1", theirs.node.id)).toBe(false);
    expect(await listUserNodes(sql, "u2")).toHaveLength(1);
    expect(await removeUserNode(sql, "u2", theirs.node.id)).toBe(true);
    expect(await removeUserNode(sql, "u2", theirs.node.id)).toBe(false);
  });

  it("goes with its account", async () => {
    await add("u1", "https://a.example");
    await sql`DELETE FROM users WHERE alias = 'u1'`;
    expect(await sql`SELECT 1 FROM user_nodes`).toHaveLength(0);
  });

  it("refuses an empty label or one longer than 80 characters", async () => {
    await expect(add("u1", "https://a.example", "")).rejects.toThrow(/user_nodes_label_check/);
    await expect(add("u1", "https://a.example", "x".repeat(81))).rejects.toThrow(/user_nodes_label_check/);
    expect((await add("u1", "https://a.example", "x".repeat(80))).ok).toBe(true);
  });

  it("refuses an origin with another scheme, a path or a space, whoever writes it", async () => {
    // The switcher navigates the page to it, so a script URL written past the API would run on this node's origin.
    for (const origin of [
      "javascript:alert(document.cookie)",
      "JAVASCRIPT://x/%0Aalert(1)",
      "data:text/html,hi",
      "https://a.example/",
      "https://a.example/path",
      "https://a b.example",
      "https://",
      "ftp://a.example",
    ]) {
      await expect(add("u1", origin, "Label"), origin).rejects.toThrow(/user_nodes_origin_check/);
      await expect(
        sql`INSERT INTO user_nodes (id, alias, label, origin, position) VALUES (${`raw_${++n}`}, 'u1', 'Label', ${origin}, 1)`,
        origin,
      ).rejects.toThrow(/user_nodes_origin_check/);
    }
    for (const origin of ["https://a.example", "http://nas.local:8787", "http://[::1]:8787", "https://xn--bcher-kva.example"]) {
      expect((await add("u1", origin, "Label")).ok, origin).toBe(true);
    }
  });
});
