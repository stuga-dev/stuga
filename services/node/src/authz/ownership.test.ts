import { describe, it, expect } from "vitest";
import { materializeAcl } from "@stuga/auth";
import { docOwnership, type DocOwnership, type OwnershipCtx } from "./ownership.js";

/** The ACL a document created at the root with this ownership gets. */
const rootAcl = (o: DocOwnership) => materializeAcl(o.owner, o.ownGrants, null, true);

/** A `Sql` stand-in for getMemberRole's query that records which (workspace, alias) was looked up. */
interface FakeSql {
  (...args: unknown[]): Promise<Array<{ role: string }>>;
  calls: Array<{ workspaceId: unknown; alias: unknown }>;
}
function sqlReturning(rows: Array<{ role: string }>): OwnershipCtx["sql"] {
  const fn = ((_strings: unknown, workspaceId: unknown, alias: unknown) => {
    fn.calls.push({ workspaceId, alias });
    return Promise.resolve(rows);
  }) as FakeSql;
  fn.calls = [];
  return fn as unknown as OwnershipCtx["sql"];
}
const callsOf = (sql: OwnershipCtx["sql"]) => (sql as unknown as FakeSql).calls;

const WS = "ws-1";
const asMember = sqlReturning([{ role: "member" }]);
const asAdmin = sqlReturning([{ role: "admin" }]);
const asGuest = sqlReturning([{ role: "guest" }]);
const notAMember = sqlReturning([]);

const human = (sql = asMember): OwnershipCtx => ({
  alias: "sub-abc",
  isAgent: false,
  sql,
  workspaceId: WS,
});
const agent = (sql: OwnershipCtx["sql"]): OwnershipCtx => ({
  alias: "agent-conn-1",
  isAgent: true,
  onBehalfOf: "sub-abc",
  sql,
  workspaceId: WS,
});

describe("docOwnership", () => {
  it("gives a human sole ownership, with no agent grant", async () => {
    const o = await docOwnership(human());
    expect(o.owner).toBe("user:sub-abc");
    expect(rootAcl(o)).toMatchObject({ principals: ["user:sub-abc"], writers: ["user:sub-abc"] });
    expect(o.ownGrants).toEqual({ p: [], w: [], c: [] });
  });

  it("checks the standing of the key's owner in this workspace, not the agent's", async () => {
    const sql = sqlReturning([{ role: "member" }]);
    await docOwnership(agent(sql));
    expect(callsOf(sql)).toEqual([{ workspaceId: WS, alias: "sub-abc" }]);
  });

  it("never queries membership for a human creator", async () => {
    const sql = sqlReturning([{ role: "member" }]);
    await docOwnership(human(sql));
    expect(callsOf(sql)).toEqual([]);
  });

  it("gives an agent's doc to the human who minted the key, agent as co-writer", async () => {
    const o = await docOwnership(agent(asMember));
    expect(o.owner).toBe("user:sub-abc");
    expect(rootAcl(o)).toMatchObject({
      principals: ["user:sub-abc", "agent:agent-conn-1"],
      writers: ["user:sub-abc", "agent:agent-conn-1"],
    });
  });

  it("records the agent grant in own_grants so a re-flatten cannot drop it", async () => {
    expect((await docOwnership(agent(asMember))).ownGrants).toEqual({
      p: ["agent:agent-conn-1"],
      w: ["agent:agent-conn-1"],
      c: [],
    });
  });

  it("honors any non-guest role", async () => {
    expect((await docOwnership(agent(asAdmin))).owner).toBe("user:sub-abc");
  });

  it("refuses to make a guest the owner", async () => {
    const o = await docOwnership(agent(asGuest));
    expect(o.owner).toBe("agent:agent-conn-1");
    expect(rootAcl(o).principals).toEqual(["agent:agent-conn-1"]);
  });

  it("refuses to make an ex-member the owner", async () => {
    const o = await docOwnership(agent(notAMember));
    expect(o.owner).toBe("agent:agent-conn-1");
  });

  it("never emits a duplicate principal", async () => {
    for (const sql of [asMember, asGuest]) {
      const { principals } = rootAcl(await docOwnership(agent(sql)));
      expect(new Set(principals).size).toBe(principals.length);
    }
  });
});
