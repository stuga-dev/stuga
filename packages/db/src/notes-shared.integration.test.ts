/**
 * `notes_shared`: an item in a person's My notes that anyone but them and their agents can read, which
 * every agent edits at `review` at least (services/node authz/review-mode.ts). Read with the row by
 * docCols and folderCols, one row at a time and in listings.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClients, createClient, type Sql } from "./client.js";
import { createDoc, getDoc, listDocs } from "./docs.js";
import { createFolder, createHomeFolder, getFolder, listFolders } from "./folders.js";
import { initSchema } from "./schema/migrate.js";
import { seedUser, seedWorkspaces } from "./testing/fixtures.js";

const URL = process.env.TEST_DATABASE_URL;
const WS = "ws-notes-shared";

describe.skipIf(!URL)("notes_shared", () => {
  let sql: Sql;

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
    await sql`DELETE FROM api_keys WHERE workspace_id = ${WS}`;
    await sql`DELETE FROM oauth_grants WHERE owner IN ('liv', 'sam')`;
    await sql`DELETE FROM users WHERE alias IN ('liv', 'sam')`;
    await seedWorkspaces(sql, WS);
    // Usernames of this file's own: the default seed-N counts from 1 in every file, and the users of
    // files run earlier are still there.
    await seedUser(sql, "liv", "Liv", null, "notes-shared-liv");
    await seedUser(sql, "sam", "Sam", null, "notes-shared-sam");
    // Liv's agent signed in over OAuth, Sam's has a key.
    await sql`INSERT INTO oauth_grants (grant_id, client_id, owner, agent_id) VALUES ('g_liv', 'c_1', 'liv', 'agent-liv')`;
    await sql`INSERT INTO api_keys (key_id, secret_hash, agent_id, owner, workspace_id) VALUES ('k_sam', 'x', 'agent-sam', 'sam', ${WS})`;
    // Liv's My notes, a folder in it, and a team folder beside it.
    await createHomeFolder(sql, { folderId: "f_notes", workspaceId: WS, alias: "liv", title: "My notes" });
    await createFolder(sql, { workspaceId: WS, folderId: "f_sub", owner: "user:liv", title: "Trips", parentId: "f_notes", aclPrincipals: ["user:liv"], aclWriters: ["user:liv"] });
    await createFolder(sql, { workspaceId: WS, folderId: "f_team", owner: "user:liv", title: "Team", parentId: null, aclPrincipals: ["user:liv", `org:${WS}`] });
  });

  const page = (docId: string, parentId: string | null, readers: string[]) =>
    createDoc(sql, { workspaceId: WS, docId, owner: "user:liv", title: docId, parentId, aclPrincipals: readers, aclWriters: readers });

  it("is false while only the person and their own agents read a page in their My notes", async () => {
    await page("d_own", "f_notes", ["user:liv", "agent:agent-liv"]);
    await page("d_deep", "f_sub", ["user:liv"]);
    expect((await getDoc(sql, "d_own"))?.notes_shared).toBe(false);
    expect((await getDoc(sql, "d_deep"))?.notes_shared).toBe(false);
    expect((await getFolder(sql, "f_notes"))?.notes_shared).toBe(false);
    expect((await getFolder(sql, "f_sub"))?.notes_shared).toBe(false);
  });

  it("is true once anyone else can read it: a person, a group, the workspace, or another person's agent", async () => {
    await page("d_sam", "f_notes", ["user:liv", "user:sam"]);
    await page("d_group", "f_sub", ["user:liv", "group:support"]);
    await page("d_org", "f_notes", ["user:liv", `org:${WS}`]);
    await page("d_agent", "f_notes", ["user:liv", "agent:agent-sam"]);
    for (const id of ["d_sam", "d_group", "d_org", "d_agent"]) {
      expect((await getDoc(sql, id))?.notes_shared, id).toBe(true);
    }
    // An agent the node holds no key or sign-in for acts for nobody else.
    await page("d_unknown_agent", "f_notes", ["user:liv", "agent:agent-gone"]);
    expect((await getDoc(sql, "d_unknown_agent"))?.notes_shared).toBe(false);
    await sql`UPDATE folders SET acl_principals = ${["user:liv", "user:sam"]} WHERE folder_id = 'f_sub'`;
    expect((await getFolder(sql, "f_sub"))?.notes_shared).toBe(true);
    expect((await getFolder(sql, "f_notes"))?.notes_shared).toBe(false);
  });

  it("is false outside every My notes, however widely it is shared", async () => {
    await page("d_team", "f_team", ["user:liv", `org:${WS}`]);
    await page("d_top", null, ["user:liv", "user:sam"]);
    expect((await getDoc(sql, "d_team"))?.notes_shared).toBe(false);
    expect((await getDoc(sql, "d_top"))?.notes_shared).toBe(false);
    expect((await getFolder(sql, "f_team"))?.notes_shared).toBe(false);
  });

  it("reads the same in listings", async () => {
    await page("d_own", "f_notes", ["user:liv"]);
    await page("d_sam", "f_sub", ["user:liv", "user:sam"]);
    await sql`UPDATE folders SET acl_principals = ${["user:liv", "user:sam"]} WHERE folder_id = 'f_sub'`;
    const docs = await listDocs(sql, ["user:liv"], WS, {});
    expect(Object.fromEntries(docs.map((d) => [d.doc_id, d.notes_shared]))).toEqual({ d_own: false, d_sam: true });
    const folders = await listFolders(sql, ["user:liv"], WS);
    expect(Object.fromEntries(folders.map((f) => [f.folder_id, f.notes_shared]))).toEqual({ f_notes: false, f_sub: true, f_team: false });
  });

  it("follows a page moved out of My notes", async () => {
    await page("d_sam", "f_notes", ["user:liv", "user:sam"]);
    expect((await getDoc(sql, "d_sam"))?.notes_shared).toBe(true);
    await sql`UPDATE docs SET parent_id = 'f_team' WHERE doc_id = 'd_sam'`;
    expect((await getDoc(sql, "d_sam"))?.notes_shared).toBe(false);
  });
});
