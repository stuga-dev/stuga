import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { provisionWorkspace, updateWorkspaceSettings, getWorkspace } from "./workspaces.js";
import { DOC_ACCESS_MODES, DEFAULT_DOC_ACCESS } from "@stuga/protocol/domain/workspaces";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("workspace default_doc_access", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE workspaces, workspace_members CASCADE`;
  });

  it("falls back to the schema DEFAULT when the mode is omitted", async () => {
    const ws = await provisionWorkspace(sql, { workspaceId: "ws-1", name: "A", owner: "alice" });
    // The create forms preselect DEFAULT_DOC_ACCESS; the column default must agree.
    expect(ws.default_doc_access).toBe(DEFAULT_DOC_ACCESS);
  });

  it("stores every mode it is given", async () => {
    for (const [i, mode] of DOC_ACCESS_MODES.entries()) {
      const ws = await provisionWorkspace(sql, {
        workspaceId: `ws-mode-${i}`,
        name: `W${i}`,
        owner: "alice",
        defaultDocAccess: mode,
      });
      expect(ws.default_doc_access).toBe(mode);
      await expect(getWorkspace(sql, `ws-mode-${i}`)).resolves.toMatchObject({ default_doc_access: mode });
    }
  });

  it("can be changed after creation", async () => {
    await provisionWorkspace(sql, { workspaceId: "ws-3", name: "A", owner: "alice", defaultDocAccess: "private" });
    const updated = await updateWorkspaceSettings(sql, "ws-3", { defaultDocAccess: "workspace_view" });
    expect(updated?.default_doc_access).toBe("workspace_view");
  });
});
