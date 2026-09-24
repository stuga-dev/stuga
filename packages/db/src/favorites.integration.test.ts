import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, listDocs, updateDoc } from "./docs.js";
import { addFavorite, listFavorites, listFavoriteDocs } from "./favorites.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const WS = "ws-fav";
const OTHER_WS = "ws-other";
const ALICE = ["user:alice", `org:${WS}`];

describe.skipIf(!URL)("favorites", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE favorites CASCADE`;
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS, OTHER_WS);
  });

  it("returns hydrated metadata, not just ids", async () => {
    await createDoc(sql, {
      workspaceId: WS,
      docId: "d1",
      owner: "user:alice",
      title: "Starred Doc",
      aclPrincipals: ALICE,
    });
    await addFavorite(sql, "alice", "d1");

    const docs = await listFavoriteDocs(sql, "alice", ALICE, WS);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.doc_id).toBe("d1");
    expect(docs[0]!.title).toBe("Starred Doc");
    expect(docs[0]!.owner).toBe("user:alice");
  });

  it("resolves a favorite far outside the 200-most-recent window of listDocs", async () => {
    await createDoc(sql, {
      workspaceId: WS,
      docId: "old-favorite",
      owner: "user:alice",
      title: "Old Favorite",
      aclPrincipals: ALICE,
    });
    await addFavorite(sql, "alice", "old-favorite");
    await sql`UPDATE docs SET updated_at = now() - interval '400 days' WHERE doc_id = 'old-favorite'`;

    for (let i = 0; i < 260; i++) {
      await createDoc(sql, {
        workspaceId: WS,
        docId: `filler-${i}`,
        owner: "user:alice",
        title: `Filler ${i}`,
        aclPrincipals: ALICE,
      });
    }

    const flat = await listDocs(sql, ALICE, WS);
    expect(flat).toHaveLength(200);
    expect(flat.some((d) => d.doc_id === "old-favorite"), "premise: it's outside the window").toBe(false);

    const docs = await listFavoriteDocs(sql, "alice", ALICE, WS);
    expect(docs.map((d) => d.doc_id)).toContain("old-favorite");
  });

  it("drops a favorite the caller can no longer see", async () => {
    await createDoc(sql, {
      workspaceId: WS,
      docId: "secret",
      owner: "user:bob",
      title: "Bob's Secret",
      aclPrincipals: ["user:bob"],
    });
    await addFavorite(sql, "alice", "secret");

    const docs = await listFavoriteDocs(sql, "alice", ALICE, WS);
    expect(docs).toHaveLength(0);
    expect(await listFavorites(sql, "alice", WS)).toContain("secret");
  });

  it("excludes trashed docs", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Trash Me", aclPrincipals: ALICE });
    await addFavorite(sql, "alice", "d1");
    expect(await listFavoriteDocs(sql, "alice", ALICE, WS)).toHaveLength(1);

    await updateDoc(sql, "d1", { trashed: true });
    expect(await listFavoriteDocs(sql, "alice", ALICE, WS)).toHaveLength(0);
  });

  it("is tenant-scoped: another workspace's doc never appears", async () => {
    await createDoc(sql, {
      workspaceId: OTHER_WS,
      docId: "cross-tenant",
      owner: "user:alice",
      title: "Other Tenant",
      aclPrincipals: ALICE,
    });
    await addFavorite(sql, "alice", "cross-tenant");

    expect(await listFavoriteDocs(sql, "alice", ALICE, WS)).toHaveLength(0);
    expect(await listFavoriteDocs(sql, "alice", ALICE, OTHER_WS)).toHaveLength(1);
  });

  it("scopes the bare id list to the workspace", async () => {
    for (const id of ["a", "b"]) {
      await createDoc(sql, { workspaceId: WS, docId: id, owner: "user:alice", title: id, aclPrincipals: ALICE });
      await addFavorite(sql, "alice", id);
    }

    expect(await listFavorites(sql, "alice", WS)).toHaveLength(2);
    expect(await listFavorites(sql, "alice", OTHER_WS)).toEqual([]);
  });

  it("keeps trashed favorites in the bare id list so the star stays clearable", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Trash Me", aclPrincipals: ALICE });
    await addFavorite(sql, "alice", "d1");
    await updateDoc(sql, "d1", { trashed: true });

    expect(await listFavorites(sql, "alice", WS)).toEqual(["d1"]);
    expect(await listFavoriteDocs(sql, "alice", ALICE, WS)).toHaveLength(0);
  });

  it("returns only the caller's own favorites", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "A", aclPrincipals: ALICE });
    await createDoc(sql, { workspaceId: WS, docId: "d2", owner: "user:alice", title: "B", aclPrincipals: ALICE });
    await addFavorite(sql, "alice", "d1");
    await addFavorite(sql, "bob", "d2");

    const docs = await listFavoriteDocs(sql, "alice", ALICE, WS);
    expect(docs.map((d) => d.doc_id)).toEqual(["d1"]);
  });

  it("orders by most recently updated", async () => {
    for (const id of ["old", "mid", "new"]) {
      await createDoc(sql, { workspaceId: WS, docId: id, owner: "user:alice", title: id, aclPrincipals: ALICE });
      await addFavorite(sql, "alice", id);
    }
    await sql`UPDATE docs SET updated_at = now() - interval '10 days' WHERE doc_id = 'old'`;
    await sql`UPDATE docs SET updated_at = now() - interval '5 days'  WHERE doc_id = 'mid'`;

    const docs = await listFavoriteDocs(sql, "alice", ALICE, WS);
    expect(docs.map((d) => d.doc_id)).toEqual(["new", "mid", "old"]);
  });

  it("returns an empty list when nothing is starred", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "A", aclPrincipals: ALICE });
    expect(await listFavoriteDocs(sql, "alice", ALICE, WS)).toEqual([]);
  });
});
