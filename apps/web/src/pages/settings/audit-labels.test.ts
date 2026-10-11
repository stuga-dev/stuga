import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../api";
import { actionLabel, actionName, actionSummary, foldAgentCalls, sharingChanges, targetName } from "./audit-labels";
import { rememberUsers } from "../../state/identity";

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

  it("words what is recorded about how a person signs in", () => {
    expect(["node.sign_in.new_device", "node.account.revoke_everything"].map((a) => actionLabel(row(a)))).toEqual([
      "Signed in from a new device",
      "Everything revoked",
    ]);
  });
});

describe("what a row says changed", () => {
  rememberUsers([
    { alias: "u_sofia", username: "sofia", display_name: "Sofia Alvarez", email: null },
    { alias: "u_ben", username: "ben", display_name: "Ben Baker", email: null },
  ]);
  const acl = (detail: Record<string, unknown>) => ({ action: "acl.set", detail }) as unknown as AuditEvent;
  const none = { p: [], w: [], c: [] };

  it("names who gained, changed or lost access, and at what level", () => {
    expect(
      actionSummary(
        acl({
          added: { p: ["user:u_sofia"], w: ["user:u_sofia", "user:u_ben"], c: [] },
          removed: { p: ["org:ws1"], w: [], c: [] },
          inherits: { before: true, after: true },
        }),
      ),
    ).toBe("Shared with Sofia Alvarez (can edit) · Stopped sharing with Everyone · Ben Baker now can edit");
  });

  it("reads a narrower level as a change, not a removal", () => {
    expect(sharingChanges({ added: none, removed: { p: [], w: ["user:u_ben"], c: [] } })).toEqual([
      { principal: "user:u_ben", change: "changed", level: "view" },
    ]);
  });

  it("says when an item stops following its folder, and counts what it does not spell out", () => {
    const many = ["a", "b", "c", "d", "e"].map((x) => `user:${x}`);
    const summary = actionSummary(acl({ added: { p: many, w: [], c: [] }, removed: none, inherits: { before: true, after: false } }));
    expect(summary).toContain("and 2 more");
    expect(summary).toContain("Stopped following its folder");
  });

  it("gives a role change its before and after, and a join its role", () => {
    expect(actionSummary({ action: "member.role", detail: { before: "member", after: "admin" } } as unknown as AuditEvent)).toBe(
      "From Member to Admin",
    );
    expect(actionSummary({ action: "invite.redeem", detail: { role: "guest" } } as unknown as AuditEvent)).toBe("Role: Guest");
    expect(actionLabel({ action: "member.remove", detail: { left: true } } as unknown as AuditEvent)).toBe("Left the workspace");
  });

  it("names an invite link by who it is for, else by its role and last characters, never by its reference", () => {
    const invite = (target_label: string | null, detail: Record<string, unknown>) =>
      ({ action: "invite.create", target_kind: "invite", target_id: "1bc1e4c22917", target_label, detail }) as unknown as AuditEvent;
    expect(targetName(invite("Sofia", { role: "member", hint: "Ab12" }))).toBe("Invite link for Sofia");
    expect(targetName(invite(null, { role: "member", hint: "Ab12" }))).toBe("Member invite link ending …Ab12");
    expect(targetName(invite(null, { role: "guest" }))).toBe("Guest invite link");
    expect(targetName(invite(null, {}))).toBe("Invite link");
  });
});

describe("an agent's tool calls", () => {
  it("read as what the tool did, never as the code", () => {
    expect(["mcp.markdown_append.append", "mcp.databases_change.update_rows", "mcp.docs.metadata", "mcp.new_tool.x"].map(actionName)).toEqual([
      "Added to a document",
      "Changed a database",
      "Looked up documents",
      "Used an agent tool",
    ]);
  });

  it("fold into the row that says what the same request did", () => {
    const events = [
      { id: 4, action: "mcp.markdown.read", request_id: "r3" },
      { id: 3, action: "doc.propose", request_id: "r2" },
      { id: 2, action: "mcp.markdown_append.append", request_id: "r2" },
      { id: 1, action: "mcp.markdown_append.append", request_id: null },
    ];
    expect(foldAgentCalls(events).map((e) => e.id)).toEqual([4, 3, 1]);
  });
});
