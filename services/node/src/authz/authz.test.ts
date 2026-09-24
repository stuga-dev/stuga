import { describe, it, expect, vi } from "vitest";
import { manages, isWorkspaceAdmin, guestForbidden } from "./authz.js";
import type { Ctx } from "../auth/context.js";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";

function ctx(role: WorkspaceRole, opts: { alias?: string; isAgent?: boolean } = {}): Ctx {
  return { alias: opts.alias ?? "alice", isAgent: opts.isAgent ?? false, role } as unknown as Ctx;
}

describe("manages", () => {
  it("lets the resource owner manage their own", () => {
    expect(manages(ctx("member"), { owner: "user:alice" })).toBe(true);
    expect(manages(ctx("guest"), { owner: "user:alice" })).toBe(true);
  });

  it("lets workspace owners/admins manage anyone's, and members/guests manage nobody else's", () => {
    expect(manages(ctx("owner"), { owner: "user:bob" })).toBe(true);
    expect(manages(ctx("admin"), { owner: "user:bob" })).toBe(true);
    expect(manages(ctx("member"), { owner: "user:bob" })).toBe(false);
    expect(manages(ctx("guest"), { owner: "user:bob" })).toBe(false);
  });

  it("never lets an agent manage, not even a resource it owns, at any role", () => {
    for (const role of ["owner", "admin", "member", "guest"] as WorkspaceRole[]) {
      expect(manages(ctx(role, { isAgent: true }), { owner: "user:alice" })).toBe(false);
      expect(manages(ctx(role, { isAgent: true }), { owner: "user:bob" })).toBe(false);
    }
  });
});

describe("isWorkspaceAdmin", () => {
  it("is manages() without the owner clause, and still refuses agents", () => {
    expect(isWorkspaceAdmin(ctx("owner"))).toBe(true);
    expect(isWorkspaceAdmin(ctx("admin"))).toBe(true);
    expect(isWorkspaceAdmin(ctx("member"))).toBe(false);
    expect(isWorkspaceAdmin(ctx("guest"))).toBe(false);
    expect(isWorkspaceAdmin(ctx("owner", { isAgent: true }))).toBe(false);
  });
});

describe("guestForbidden", () => {
  it("returns null for every non-guest role", () => {
    for (const role of ["owner", "admin", "member"] as WorkspaceRole[]) {
      expect(guestForbidden(ctx(role))).toBeNull();
    }
  });

  it("refuses guests with 403 and completes the sentence", async () => {
    const res = guestForbidden(ctx("guest"), "manage api keys");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect((await res!.json()).error).toBe("guests cannot manage api keys");
  });

  it("has a usable default message", async () => {
    const res = guestForbidden(ctx("guest"));
    expect((await res!.json()).error).toBe("guests cannot perform this action in this workspace");
  });
});

describe("isNodeAdmin", () => {
  async function check(opts: { inTable?: boolean; isAgent?: boolean; alias?: string }): Promise<boolean> {
    vi.resetModules();
    vi.doMock("@stuga/db", () => ({ isNodeAdminAlias: async () => opts.inTable ?? false }));
    const { isNodeAdmin } = await import("./authz.js");
    return isNodeAdmin({
      alias: opts.alias ?? "u_alice",
      isAgent: opts.isAgent ?? false,
      sql: {},
      env: {},
    } as never);
  }

  it("grants from the node_admins table, the one roster", async () => {
    expect(await check({ inTable: true })).toBe(true);
    expect(await check({ inTable: false })).toBe(false);
  });

  it("never grants to an agent", async () => {
    expect(await check({ isAgent: true, inTable: true })).toBe(false);
  });
});
