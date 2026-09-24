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
});
