import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../api";
import { actionLabel } from "./audit-labels";

const row = (action: string) => ({ action, detail: {} }) as unknown as AuditEvent;

describe("actionLabel", () => {
  it("words every collection change, whoever made it", () => {
    expect(
      ["collection.create", "collection.rename", "collection.delete", "collection.items.add", "collection.items.remove"].map((a) => actionLabel(row(a))),
    ).toEqual(["Collection created", "Collection renamed", "Collection deleted", "Added to a collection", "Removed from a collection"]);
  });

  it("words a change to instructions for agents at every level", () => {
    expect(["workspace.agent_instructions", "folder.agent_instructions", "doc.agent_instructions"].map((a) => actionLabel(row(a)))).toEqual([
      "Workspace agent instructions changed",
      "Folder agent instructions changed",
      "Agent instructions changed",
    ]);
  });
});
