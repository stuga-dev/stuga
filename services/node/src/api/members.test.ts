/**
 * Membership changes leave audit rows that name the person and, for a role change, both roles, and
 * reach the person's open pages in that workspace at once. Adding looks only among people the
 * adder may find, and answers anyone else as no account at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", () => ({
  addOrPromoteWorkspaceMember: vi.fn(),
  countWorkspaceOwners: vi.fn(async () => 2),
  dropWorkspaceFromOwnerGrants: vi.fn(async () => 0),
  getKnownUserAliasByHandle: vi.fn(async () => null),
  getMemberRole: vi.fn(),
  getUserDisplayName: vi.fn(async (_sql: unknown, alias: string) => (alias === "u_sofia" ? "Sofia Alvarez" : "")),
  getWorkspace: vi.fn(async () => ({ workspace_id: "ws1", name: "Bakery" })),
  isKnownAccount: vi.fn(async () => true),
  isNodeAdminAlias: vi.fn(async () => false),
  isWorkspaceMember: vi.fn(async () => true),
  listWorkspaceMembers: vi.fn(async () => []),
  removeWorkspaceMember: vi.fn(async () => true),
  revokeWorkspaceApiKeysForOwner: vi.fn(async () => []),
  searchAccounts: vi.fn(async () => []),
  updateMemberRole: vi.fn(async () => "updated"),
}));

const db = await import("@stuga/db");
const { changeMemberRole, inviteMember, listMemberCandidates, removeMember } = await import("./members.js");
import type { WorkspaceCall } from "../http/router.js";
import { personCtx, recordingJobs } from "../testing/ctx.js";

const roles = new Map<string, string>();
const mockAdd = db.addOrPromoteWorkspaceMember as unknown as ReturnType<typeof vi.fn>;
const mockKnown = db.isKnownAccount as unknown as ReturnType<typeof vi.fn>;
const mockByHandle = db.getKnownUserAliasByHandle as unknown as ReturnType<typeof vi.fn>;
const mockSearch = db.searchAccounts as unknown as ReturnType<typeof vi.fn>;
const mockNodeAdmin = db.isNodeAdminAlias as unknown as ReturnType<typeof vi.fn>;
let jobs = recordingJobs();
const closeMembership = vi.fn(() => 1);
const reopenMembership = vi.fn(() => 1);

function call(method: string, path: string, match: string[], body?: unknown): WorkspaceCall {
  const req = new Request(`http://node.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctx = personCtx({ alias: "u_liv", role: "owner", env: { jobs, sessionSockets: { closeMembership, reopenMembership } } });
  return { ctx, req, url: new URL(req.url), match } as unknown as WorkspaceCall;
}

/** The audit rows sent, after the fire-and-forget sends settle. */
async function audits() {
  await new Promise((r) => setTimeout(r, 0));
  return jobs.audits();
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs = recordingJobs();
  roles.clear();
  roles.set("u_liv", "owner");
  roles.set("u_sofia", "member");
  (db.getMemberRole as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_sql: unknown, _ws: string, alias: string) => roles.get(alias) ?? null);
});

describe("membership in the audit log", () => {
  it("a role change names the person and both roles", async () => {
    const path = "/api/workspaces/ws1/members/u_sofia";
    const res = await changeMemberRole(call("PATCH", path, [path, "ws1", "u_sofia"], { role: "admin" }));
    expect(res.status).toBe(200);
    expect(await audits()).toEqual([
      expect.objectContaining({
        action: "member.role",
        workspaceId: "ws1",
        actor: "u_liv",
        targetKind: "user",
        targetId: "u_sofia",
        targetLabel: "Sofia Alvarez",
        detail: { before: "member", after: "admin" },
      }),
    ]);
  });

  it("choosing the role someone already has records nothing", async () => {
    const path = "/api/workspaces/ws1/members/u_sofia";
    await changeMemberRole(call("PATCH", path, [path, "ws1", "u_sofia"], { role: "member" }));
    expect(await audits()).toEqual([]);
  });

  it("a removal and a leave are told apart", async () => {
    const path = "/api/workspaces/ws1/members/u_sofia";
    await removeMember(call("DELETE", path, [path, "ws1", "u_sofia"]));
    const own = "/api/workspaces/ws1/members/u_liv";
    await removeMember(call("DELETE", own, [own, "ws1", "u_liv"]));
    expect((await audits()).map((row) => [row.action, row.targetId, row.detail])).toEqual([
      ["member.remove", "u_sofia", { role: "member", left: false }],
      ["member.remove", "u_liv", { role: "owner", left: true }],
    ]);
  });

  it("adding someone records the add, and an existing member records nothing", async () => {
    const path = "/api/workspaces/ws1/members";
    mockAdd.mockResolvedValueOnce({ outcome: "added", role: "guest" });
    await inviteMember(call("POST", path, [path, "ws1"], { alias: "u_gus", role: "guest" }));
    mockAdd.mockResolvedValueOnce({ outcome: "already_member", role: "member" });
    await inviteMember(call("POST", path, [path, "ws1"], { alias: "u_sofia", role: "guest" }));
    expect((await audits()).map((row) => [row.action, row.targetId, row.targetLabel, row.detail])).toEqual([
      ["member.add", "u_gus", null, { role: "guest" }],
    ]);
  });
});

describe("open pages", () => {
  const path = "/api/workspaces/ws1/members/u_sofia";

  it("a removal closes their open pages in the workspace for good", async () => {
    const res = await removeMember(call("DELETE", path, [path, "ws1", "u_sofia"]));
    expect(res.status).toBe(200);
    expect(closeMembership).toHaveBeenCalledWith("u_sofia", "ws1");
  });

  it("a refused removal closes nothing", async () => {
    roles.set("u_liv", "guest");
    const res = await removeMember(call("DELETE", path, [path, "ws1", "u_sofia"]));
    expect(res.status).toBe(403);
    expect(closeMembership).not.toHaveBeenCalled();
  });

  it("a role change reopens their pages, so the new reach applies there", async () => {
    const res = await changeMemberRole(call("PATCH", path, [path, "ws1", "u_sofia"], { role: "guest" }));
    expect(res.status).toBe(200);
    expect(reopenMembership).toHaveBeenCalledWith("u_sofia", "ws1");
  });

  it("adding a guest as a member reopens their pages too, and a new member has none", async () => {
    const members = "/api/workspaces/ws1/members";
    mockAdd.mockResolvedValueOnce({ outcome: "promoted", role: "member" });
    await inviteMember(call("POST", members, [members, "ws1"], { alias: "u_gus", role: "member" }));
    expect(reopenMembership).toHaveBeenCalledWith("u_gus", "ws1");
    reopenMembership.mockClear();
    mockAdd.mockResolvedValueOnce({ outcome: "added", role: "member" });
    await inviteMember(call("POST", members, [members, "ws1"], { alias: "u_omar", role: "member" }));
    expect(reopenMembership).not.toHaveBeenCalled();
  });

  it("the same role leaves their pages alone", async () => {
    await changeMemberRole(call("PATCH", path, [path, "ws1", "u_sofia"], { role: "member" }));
    expect(reopenMembership).not.toHaveBeenCalled();
  });
});

describe("whom adding can find", () => {
  const members = "/api/workspaces/ws1/members";
  const candidates = "/api/workspaces/ws1/member-candidates?q=gus";

  it("looks only among people the adder shares a workspace with, picked or typed", async () => {
    await listMemberCandidates(call("GET", candidates, [candidates, "ws1"]));
    expect(mockSearch).toHaveBeenCalledWith(expect.anything(), "gus", { outsideWorkspace: "ws1", knownTo: "u_liv" });
    await inviteMember(call("POST", members, [members, "ws1"], { alias: "u_gus" }));
    expect(mockKnown).toHaveBeenCalledWith(expect.anything(), "u_gus", "u_liv");
    mockByHandle.mockResolvedValueOnce("u_gus");
    await inviteMember(call("POST", members, [members, "ws1"], { username: "gus" }));
    expect(mockByHandle).toHaveBeenCalledWith(expect.anything(), "gus", "u_liv");
  });

  it("a node administrator looks across the node", async () => {
    mockNodeAdmin.mockResolvedValue(true);
    try {
      await listMemberCandidates(call("GET", candidates, [candidates, "ws1"]));
      expect(mockSearch).toHaveBeenCalledWith(expect.anything(), "gus", { outsideWorkspace: "ws1", knownTo: null });
      await inviteMember(call("POST", members, [members, "ws1"], { alias: "u_gus" }));
      expect(mockKnown).toHaveBeenCalledWith(expect.anything(), "u_gus", null);
      await inviteMember(call("POST", members, [members, "ws1"], { username: "gus" }));
      expect(mockByHandle).toHaveBeenCalledWith(expect.anything(), "gus", null);
    } finally {
      mockNodeAdmin.mockResolvedValue(false);
    }
  });

  it("answers someone the adder cannot find as no account at all, and adds no one", async () => {
    mockKnown.mockResolvedValueOnce(false);
    const picked = await inviteMember(call("POST", members, [members, "ws1"], { alias: "u_far" }));
    expect(picked.status).toBe(400);
    expect((await picked.json()).error).toBe("No account matches that person. Send them an invite link instead.");
    const typed = await inviteMember(call("POST", members, [members, "ws1"], { username: "far" }));
    expect(typed.status).toBe(400);
    expect((await typed.json()).error).toBe("No account matches far. Send them an invite link instead.");
    expect(mockAdd).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });
});
