import { describe, expect, it } from "vitest";
import { orgPrincipal } from "@stuga/auth";
import type { Sql } from "@stuga/db";
import { resolvePrincipals } from "./principals.js";

const WS = "ws-1";

describe("resolvePrincipals", () => {
  it("includes self, the workspace org principal, and workspace-scoped db groups", async () => {
    const sql = (() => [{ group_id: "group:db-team", members: ["user:alice"] }]) as unknown as Sql;
    const principals = await resolvePrincipals(sql, "alice", WS, "member");
    expect(principals).toContain("user:alice");
    expect(principals).toContain(orgPrincipal(WS));
    expect(principals).not.toContain("org:all");
    expect(principals).toContain("group:db-team");
    expect(new Set(principals).size).toBe(principals.length);
  });

  it("does not grant a guest workspace-wide access", async () => {
    const sql = (() => []) as unknown as Sql;
    expect(await resolvePrincipals(sql, "external", WS, "guest")).toEqual(["user:external"]);
  });
});
