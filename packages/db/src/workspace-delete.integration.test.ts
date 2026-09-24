import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import {
  provisionWorkspace,
  addWorkspaceMember,
  deleteWorkspaceCascade,
  insertWorkspaceInvite,
  listWorkspacesForUser,
  getWorkspace,
  upsertGroup,
} from "./workspaces.js";
import { createDoc } from "./docs.js";
import { createFolder } from "./folders.js";
import { insertShareLink } from "./sharing.js";
import { insertOauthCode, insertApiKey } from "./agents.js";
import { createCollection } from "./collections.js";
import { insertNotification } from "./notifications.js";
import { insertWorkspaceEvent, upsertAgentRun } from "./governance.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("deleteWorkspaceCascade", () => {
  let sql: Sql;
  const DOOMED = "ws-doomed";
  const KEEP = "ws-keep";

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE workspaces, ai_usage, users CASCADE`;
    await provisionWorkspace(sql, { workspaceId: DOOMED, name: "Doomed", owner: "alice" });
    await provisionWorkspace(sql, { workspaceId: KEEP, name: "Keep", owner: "bob" });
  });

  /** A row in every tenant table. */
  async function fill(ws: string, owner: string, suffix: string) {
    await createDoc(sql, { docId: `d-${suffix}`, workspaceId: ws, owner: `user:${owner}`, title: "Doc" });
    await createFolder(sql, { folderId: `f-${suffix}`, workspaceId: ws, owner: `user:${owner}`, title: "Folder" });
    await insertWorkspaceInvite(sql, {
      tokenHash: `invite-${suffix}`,
      workspaceId: ws,
      role: "member",
      createdBy: owner,
      expiresAt: null,
      maxUses: 5,
    });
    await insertShareLink(sql, {
      tokenHash: `share-${suffix}`,
      docId: `d-${suffix}`,
      workspaceId: ws,
      role: "viewer",
      createdBy: owner,
      expiresAt: null,
    });
    await insertOauthCode(sql, {
      codeHash: `code-${suffix}`,
      clientId: "client-x",
      userAlias: owner,
      workspaceId: ws,
      redirectUri: "https://example.test/cb",
      codeChallenge: "challenge",
      expiresAt: new Date(Date.now() + 600_000),
    });
    await upsertGroup(sql, `group:${suffix}`, [`user:${owner}`], ws);
    await createCollection(sql, { collectionId: `c-${suffix}`, workspaceId: ws, owner, name: "Collection" });
    await insertApiKey(sql, { keyId: `k-${suffix}`, secretHash: "h", agentId: `agent-${suffix}`, owner, workspaceId: ws, name: "Key" });
    await insertNotification(sql, {
      id: `n-${suffix}`,
      workspace_id: ws,
      recipient_alias: owner,
      event_type: "DIRECT_DOC_PERMISSIONS",
      resource_id: `d-${suffix}`,
      resource_title: "Doc",
      resource_url: null,
      actor_alias: owner,
      payload: {},
    });
    const now = Date.now();
    await upsertAgentRun(sql, {
      runId: `r-${suffix}`, workspaceId: ws, docId: `d-${suffix}`, docKind: "prose", docTitle: "Doc", source: "stdio",
      agent: "Agent", agentAlias: `agent-${suffix}`, client: null, model: null, reviewer: owner, status: "open",
      reviewMode: "review", autoApplied: false, reverted: false, acknowledged: false,
      pending: 1, accepted: 0, rejected: 0, conflicts: 0, applied: 0, createdAt: now, updatedAt: now,
    });
    await insertWorkspaceEvent(sql, { workspaceId: ws, type: "doc.created", docId: `d-${suffix}`, actor: `user:${owner}`, actorKind: "human" });
  }

  async function countIn(table: string, ws: string): Promise<number> {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(table)} WHERE workspace_id = ${ws}`;
    return rows[0]?.n ?? 0;
  }

  const TENANT_TABLES = [
    "docs",
    "folders",
    "workspace_members",
    "workspace_invites",
    "share_links",
    "oauth_codes",
    "groups",
    "collections",
    "api_keys",
    "notifications",
    "agent_runs",
    "workspace_events",
  ];

  it("removes every tenant-scoped row for the deleted workspace", async () => {
    await fill(DOOMED, "alice", "doomed");

    for (const t of TENANT_TABLES) {
      expect(await countIn(t, DOOMED), `${t} should be populated before delete`).toBeGreaterThan(0);
    }

    const result = await deleteWorkspaceCascade(sql, DOOMED);
    expect(result?.docs).toEqual([{ doc_id: "d-doomed", doc_type: expect.any(String) }]);

    for (const t of TENANT_TABLES) {
      expect(await countIn(t, DOOMED), `${t} still holds rows for the deleted workspace`).toBe(0);
    }
    expect(await getWorkspace(sql, DOOMED)).toBeNull();
  });

  it("leaves the neighbouring workspace completely intact", async () => {
    await fill(DOOMED, "alice", "doomed");
    await fill(KEEP, "bob", "keep");

    await deleteWorkspaceCascade(sql, DOOMED);

    for (const t of TENANT_TABLES) {
      expect(await countIn(t, KEEP), `${t} lost rows belonging to the surviving workspace`).toBeGreaterThan(0);
    }
    expect(await getWorkspace(sql, KEEP)).not.toBeNull();
  });

  it("drops the deleted workspace from a multi-workspace member's list", async () => {
    await addWorkspaceMember(sql, DOOMED, "bob", "member");
    expect((await listWorkspacesForUser(sql, "bob")).map((w) => w.workspace_id).sort()).toEqual([DOOMED, KEEP].sort());

    await deleteWorkspaceCascade(sql, DOOMED);

    expect((await listWorkspacesForUser(sql, "bob")).map((w) => w.workspace_id)).toEqual([KEEP]);
  });

  it("returns null for an unknown workspace instead of deleting anything", async () => {
    await fill(KEEP, "bob", "keep");
    expect(await deleteWorkspaceCascade(sql, "ws-does-not-exist")).toBeNull();
    expect(await countIn("docs", KEEP)).toBe(1);
  });
});
