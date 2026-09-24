import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, getDoc, setDocAgentInstructions, updateDoc } from "./docs.js";
import { createFolder, updateFolder } from "./folders.js";
import { updateWorkspaceSettings } from "./workspaces.js";
import { resolveDocInstructions, resolveFolderInstructions } from "./instructions.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const ALICE = ["user:alice", "org:ws-instructions-test"];

describe.skipIf(!URL)("instructions for agents, stacked", () => {
  let sql: Sql;
  const WS = "ws-instructions-test";
  const OTHER_WS = "ws-instructions-other";

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await sql`TRUNCATE folders CASCADE`;
    await seedWorkspaces(sql, WS, OTHER_WS);
    await updateWorkspaceSettings(sql, WS, { name: "Acme", agentInstructions: "  workspace rule \n" });
    // Root › Contracts › 2026, and a sibling top-level folder.
    await createFolder(sql, { workspaceId: WS, folderId: "f_root", owner: "user:alice", title: "Root", parentId: null });
    await createFolder(sql, { workspaceId: WS, folderId: "f_contracts", owner: "user:alice", title: "Contracts", parentId: "f_root" });
    await createFolder(sql, { workspaceId: WS, folderId: "f_2026", owner: "user:alice", title: "2026", parentId: "f_contracts" });
    await createFolder(sql, { workspaceId: WS, folderId: "f_other", owner: "user:alice", title: "Other", parentId: null });
    await updateFolder(sql, "f_root", { agentInstructions: "root rule" });
    await updateFolder(sql, "f_2026", { agentInstructions: "2026 rule" });
    await updateFolder(sql, "f_other", { agentInstructions: "other rule" });
  });

  async function doc(docId: string, parentId: string | null, extra: { docType?: "prose" | "database"; pageOf?: string } = {}) {
    return createDoc(sql, { docId, workspaceId: WS, owner: "user:alice", title: docId, parentId, ...extra });
  }

  it("stacks the workspace, every folder root-down, then the document; blank levels are left out", async () => {
    await doc("d1", "f_2026");
    await setDocAgentInstructions(sql, "d1", "doc rule");
    const levels = await resolveDocInstructions(sql, (await getDoc(sql, "d1"))!, ALICE);
    expect(levels).toEqual([
      { kind: "workspace", id: WS, title: "Acme", text: "workspace rule" },
      { kind: "folder", id: "f_root", title: "Root", text: "root rule" },
      { kind: "folder", id: "f_2026", title: "2026", text: "2026 rule" },
      { kind: "document", id: "d1", title: "d1", text: "doc rule" },
    ]);
  });

  it("follows a move at once", async () => {
    await doc("d1", "f_2026");
    await updateDoc(sql, "d1", { parentId: "f_other" });
    const levels = await resolveDocInstructions(sql, (await getDoc(sql, "d1"))!, ALICE);
    expect(levels.map((l) => l.id)).toEqual([WS, "f_other"]);
  });

  it("gives a document at the root only the workspace level", async () => {
    await doc("d1", null);
    expect((await resolveDocInstructions(sql, (await getDoc(sql, "d1"))!, ALICE)).map((l) => l.id)).toEqual([WS]);
  });

  it("puts a row page under its database and the database's folders, not its own parent", async () => {
    await doc("db1", "f_2026", { docType: "database" });
    await setDocAgentInstructions(sql, "db1", "database rule");
    await doc("page1", "f_other", { pageOf: "db1" });
    await setDocAgentInstructions(sql, "page1", "page rule");
    const levels = await resolveDocInstructions(sql, (await getDoc(sql, "page1"))!, ALICE);
    expect(levels.map((l) => [l.kind, l.id])).toEqual([
      ["workspace", WS],
      ["folder", "f_root"],
      ["folder", "f_2026"],
      ["database", "db1"],
      ["document", "page1"],
    ]);
  });

  it("labels a database's own level as a database", async () => {
    await doc("db1", null, { docType: "database" });
    await setDocAgentInstructions(sql, "db1", "database rule");
    const levels = await resolveDocInstructions(sql, (await getDoc(sql, "db1"))!, ALICE);
    expect(levels.at(-1)).toEqual({ kind: "database", id: "db1", title: "db1", text: "database rule" });
  });

  it("resolves a folder's stack ending with its own level, and the root's as the workspace alone", async () => {
    expect((await resolveFolderInstructions(sql, WS, "f_2026", ALICE)).map((l) => l.id)).toEqual([WS, "f_root", "f_2026"]);
    expect((await resolveFolderInstructions(sql, WS, "f_contracts", ALICE)).map((l) => l.id)).toEqual([WS, "f_root"]);
    expect((await resolveFolderInstructions(sql, WS, null, ALICE)).map((l) => l.id)).toEqual([WS]);
  });

  it("never reads across tenants", async () => {
    await createFolder(sql, { workspaceId: OTHER_WS, folderId: "f_foreign", owner: "user:bob", title: "Foreign", parentId: null });
    await updateFolder(sql, "f_foreign", { agentInstructions: "foreign rule" });
    expect((await resolveFolderInstructions(sql, WS, "f_foreign", ["user:bob"])).map((l) => l.id)).toEqual([WS]);
  });

  it("leaves out folders and databases the reader cannot open, but climbs through them", async () => {
    // Bob can read Root and the document, not 2026 (private to Alice) nor the database.
    await sql`UPDATE folders SET acl_principals = '{user:alice,user:bob}' WHERE folder_id = 'f_root'`;
    await doc("db1", "f_2026", { docType: "database" });
    await setDocAgentInstructions(sql, "db1", "database rule");
    await doc("page1", "f_2026", { pageOf: "db1" });
    await setDocAgentInstructions(sql, "page1", "page rule");
    const bob = ["user:bob"];
    const levels = await resolveDocInstructions(sql, (await getDoc(sql, "page1"))!, bob);
    expect(levels.map((l) => l.id)).toEqual([WS, "f_root", "page1"]);
    // Alice, the owner of everything, reads the full stack.
    expect((await resolveDocInstructions(sql, (await getDoc(sql, "page1"))!, ALICE)).map((l) => l.id)).toEqual([
      WS,
      "f_root",
      "f_2026",
      "db1",
      "page1",
    ]);
  });

  it("stops at the depth cap on a cycle rather than looping", async () => {
    await sql`UPDATE folders SET parent_id = 'f_2026' WHERE folder_id = 'f_root'`;
    const levels = await resolveFolderInstructions(sql, WS, "f_2026", ALICE);
    expect(levels.length).toBeLessThanOrEqual(33);
  });
});
