import type { DocRow, FolderRow } from "@stuga/db";
import { describe, expect, it } from "vitest";
import { docSummary, folderSummary } from "./summaries.js";

describe("summaries", () => {
  it("keeps a document's ACL arrays and grants out of what a browser sees", () => {
    const row = {
      doc_id: "d1",
      title: "Roadmap",
      owner: "user:ada",
      doc_type: "prose",
      parent_id: null,
      agent_mode: "review",
      page_of: null,
      page_row: null,
      acl_principals: ["user:ada"],
      acl_writers: ["user:ada"],
      own_grants: { p: [], w: [], c: [] },
    } as unknown as DocRow;
    const summary = docSummary(row);
    expect(summary).toMatchObject({ doc_id: "d1", title: "Roadmap", owner: "user:ada", agent_mode: "review" });
    expect(summary).not.toHaveProperty("acl_principals");
    expect(summary).not.toHaveProperty("acl_writers");
    expect(summary).not.toHaveProperty("own_grants");
  });

  it("keeps a folder's ACL arrays out of what a browser sees", () => {
    const row = { folder_id: "f1", title: "Plans", owner: "user:ada", parent_id: null, acl_writers: ["user:ada"] } as unknown as FolderRow;
    const summary = folderSummary(row);
    expect(summary).toMatchObject({ folder_id: "f1", title: "Plans" });
    expect(summary).not.toHaveProperty("acl_writers");
  });

  it("says the level the node holds every agent to, and each floor under it", () => {
    const row = (over: Partial<DocRow>) =>
      ({ doc_id: "d1", title: "x", parent_id: "f1", agent_mode: null, folder_agent_mode: null, database_agent_mode: null, notes_shared: false, ...over }) as unknown as DocRow;
    expect(docSummary(row({}))).toMatchObject({ agent_mode: "review", agent_mode_floor: "review", agent_mode_floors: { folder: "review", database: null, notes: null } });
    // A row page is never looser than its database, whatever its folder gives it.
    expect(docSummary(row({ folder_agent_mode: "auto", database_agent_mode: "colleague" }))).toMatchObject({
      agent_mode: "colleague",
      agent_mode_floor: "colleague",
      agent_mode_floors: { folder: "auto", database: "colleague", notes: null },
    });
    // My notes applies directly until a page there is shared; then every agent's edits wait.
    expect(docSummary(row({ folder_agent_mode: "auto" }))).toMatchObject({ agent_mode: "auto", agent_mode_floor: "auto" });
    expect(docSummary(row({ folder_agent_mode: "auto", notes_shared: true }))).toMatchObject({
      agent_mode: "review",
      agent_mode_floor: "review",
      agent_mode_floors: { folder: "auto", database: null, notes: "review" },
    });
    expect(docSummary(row({ parent_id: null, agent_mode: "colleague", notes_shared: true }))).toMatchObject({ agent_mode: "colleague", agent_mode_floor: "review" });
    expect(docSummary(row({ parent_id: null }))).toMatchObject({ agent_mode: "review", agent_mode_floor: null });
  });
});
