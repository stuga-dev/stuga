import { describe, it, expect } from "vitest";
import {
  atLeast, canGrantRole, isInviteRole, isShareRole, isWorkspaceRole,
  INVITE_ROLES, SHARE_ROLES, type WorkspaceRole,
} from "./roles.js";

/** High to low. */
const WORKSPACE_ROLE_ORDER: readonly WorkspaceRole[] = ["owner", "admin", "member", "guest"];

describe("workspace role ordering", () => {
  it("ranks the full order, high to low", () => {
    for (let i = 0; i < WORKSPACE_ROLE_ORDER.length; i++) {
      for (let j = 0; j < WORKSPACE_ROLE_ORDER.length; j++) {
        expect(atLeast(WORKSPACE_ROLE_ORDER[i]!, WORKSPACE_ROLE_ORDER[j]!)).toBe(i <= j);
      }
    }
  });

  it("is reflexive", () => {
    for (const r of WORKSPACE_ROLE_ORDER) expect(atLeast(r, r)).toBe(true);
  });
});

describe("canGrantRole (the anti-escalation rule)", () => {
  it("lets only an owner grant owner or admin", () => {
    expect(canGrantRole("owner", "owner")).toBe(true);
    expect(canGrantRole("owner", "admin")).toBe(true);
    expect(canGrantRole("admin", "admin")).toBe(false);
    expect(canGrantRole("admin", "owner")).toBe(false);
    expect(canGrantRole("member", "admin")).toBe(false);
  });

  it("lets owners and admins grant member/guest, and nobody below them", () => {
    for (const g of ["member", "guest"] as WorkspaceRole[]) {
      expect(canGrantRole("owner", g)).toBe(true);
      expect(canGrantRole("admin", g)).toBe(true);
      expect(canGrantRole("member", g)).toBe(false);
      expect(canGrantRole("guest", g)).toBe(false);
    }
  });
});

describe("vocabulary guards", () => {
  it("accepts exactly the workspace roles", () => {
    for (const r of WORKSPACE_ROLE_ORDER) expect(isWorkspaceRole(r)).toBe(true);
    const inherited = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"];
    for (const bad of ["viewer", "MEMBRE", "", "Owner", null, 7, undefined, ...inherited]) {
      expect(isWorkspaceRole(bad)).toBe(false);
    }
  });

  it("excludes owner from invite roles — ownership is never handed out by a link", () => {
    expect(INVITE_ROLES).toEqual(["admin", "member", "guest"]);
    expect(isInviteRole("owner")).toBe(false);
    for (const r of INVITE_ROLES) expect(isInviteRole(r)).toBe(true);
  });

  it("keeps share roles a separate vocabulary from workspace roles", () => {
    expect(SHARE_ROLES).toEqual(["viewer", "commenter", "editor"]);
    for (const r of SHARE_ROLES) {
      expect(isShareRole(r)).toBe(true);
      expect(isWorkspaceRole(r)).toBe(false);
    }
    for (const r of WORKSPACE_ROLE_ORDER) expect(isShareRole(r)).toBe(false);
  });
});
