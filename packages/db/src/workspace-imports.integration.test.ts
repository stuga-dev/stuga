import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import {
  addWorkspaceMember,
  finishWorkspaceImport,
  getWorkspace,
  listUnfinishedImports,
  listWorkspacesForUser,
  provisionWorkspace,
  resolveHumanAuth,
} from "./workspaces.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const LIV = "u_liv_imports";
const IN_USE = "ws-imports-in-use";
const IMPORTING = "ws-imports-importing";

describe.skipIf(!URL)("a workspace an archive is being imported into", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await sql`DELETE FROM workspaces WHERE workspace_id IN (${IN_USE}, ${IMPORTING})`;
    await closeClients();
  });

  beforeEach(async () => {
    await sql`DELETE FROM workspaces WHERE workspace_id IN (${IN_USE}, ${IMPORTING})`;
  });

  it("is marked in the transaction that makes it, and only then", async () => {
    await provisionWorkspace(sql, { workspaceId: IN_USE, name: "Team", owner: LIV });
    const made = await provisionWorkspace(sql, { workspaceId: IMPORTING, name: "Privacy laws", owner: LIV, importing: true });
    expect(made.import_started_at).not.toBeNull();
    expect((await getWorkspace(sql, IN_USE))!.import_started_at).toBeNull();
    const unfinished = (await listUnfinishedImports(sql)).filter((w) => [IN_USE, IMPORTING].includes(w.workspace_id));
    expect(unfinished.map(({ workspace_id, name }) => ({ workspace_id, name }))).toEqual([{ workspace_id: IMPORTING, name: "Privacy laws" }]);
  });

  it("is in no list of its owner's until the import is finished, nor the one a request without a workspace lands in", async () => {
    await provisionWorkspace(sql, { workspaceId: IMPORTING, name: "Privacy laws", owner: LIV, importing: true });
    expect(await listWorkspacesForUser(sql, LIV)).toEqual([]);
    expect((await resolveHumanAuth(sql, LIV, `user:${LIV}`, null)).membership).toBeNull();
    // The import's own requests name it, and reach it.
    expect((await resolveHumanAuth(sql, LIV, `user:${LIV}`, IMPORTING)).membership).toEqual({ workspace_id: IMPORTING, role: "owner" });

    await provisionWorkspace(sql, { workspaceId: IN_USE, name: "Team", owner: "u_ada_imports" });
    await addWorkspaceMember(sql, IN_USE, LIV);
    expect((await listWorkspacesForUser(sql, LIV)).map((w) => w.workspace_id)).toEqual([IN_USE]);
    expect((await resolveHumanAuth(sql, LIV, `user:${LIV}`, null)).membership).toEqual({ workspace_id: IN_USE, role: "member" });

    expect(await finishWorkspaceImport(sql, IMPORTING)).toBe(true);
    expect((await listWorkspacesForUser(sql, LIV)).map((w) => w.workspace_id)).toEqual([IMPORTING, IN_USE]);
    expect((await listUnfinishedImports(sql)).some((w) => w.workspace_id === IMPORTING)).toBe(false);
    // Finished once: a second finish, or one of a workspace never imported, changes nothing.
    expect(await finishWorkspaceImport(sql, IMPORTING)).toBe(false);
    expect(await finishWorkspaceImport(sql, IN_USE)).toBe(false);
  });
});
