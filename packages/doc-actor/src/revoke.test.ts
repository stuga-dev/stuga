/**
 * /revoke ends exactly the sessions an ACL change locked out, judged by the
 * principals each socket was admitted with (group, org, agent), not its alias.
 */
import { describe, expect, it } from "vitest";
import { connect, harness, makeActor, type Harness } from "../test/harness.js";
import type { DocActor } from "./doc-actor.js";

/** Aliases still connected, in connect order (a closed socket vanishes). */
function connected(h: Harness): string[] {
  return h.state
    .getWebSockets()
    .map((ws) => ws.meta.alias);
}

async function revoke(actor: DocActor, allowed: string[]): Promise<void> {
  const u = new URL("http://actor/revoke");
  u.searchParams.set("docId", "d1");
  for (const p of allowed) u.searchParams.append("principal", p);
  u.searchParams.set("writersStated", "1");
  for (const p of allowed) u.searchParams.append("writer", p);
  const res = await actor.fetch(new Request(u.toString()));
  expect(res.status).toBe(204);
}

describe("/revoke", () => {
  it("keeps a session the ACL admits by a group, the workspace, or an agent principal", async () => {
    const h = harness();
    const actor = makeActor(h);
    await connect(actor, h, { docId: "d1", alias: "alice", principal: ["user:alice", "group:eng"] });
    await connect(actor, h, { docId: "d1", alias: "bob", principal: ["user:bob", "org:ws1"] });
    await connect(actor, h, { docId: "d1", alias: "agent-7", principal: ["agent:agent-7"] });
    await connect(actor, h, { docId: "d1", alias: "mallory", principal: ["user:mallory"] });

    // Not one of these three aliases is named in the ACL.
    await revoke(actor, ["user:owner", "group:eng", "org:ws1", "agent:agent-7"]);

    expect(connected(h)).toEqual(["alice", "bob", "agent-7"]);
  });

  it("ends a session the ACL no longer names at all", async () => {
    const h = harness();
    const actor = makeActor(h);
    await connect(actor, h, { docId: "d1", alias: "alice", principal: ["user:alice", "group:eng"] });

    await revoke(actor, ["user:owner"]);

    expect(connected(h)).toEqual([]);
  });
});
