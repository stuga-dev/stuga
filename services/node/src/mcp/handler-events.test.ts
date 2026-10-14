/**
 * The `events` tool on /mcp: what `mine` asks the feed for, an agent's own events, which are the
 * decisions on its runs and the replies in comment threads it started.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  latestWorkspaceEventId: vi.fn(),
  listWorkspaceEvents: vi.fn(),
}));

vi.mock("@stuga/db", async (orig) => ({ ...(await orig<typeof import("@stuga/db")>()), ...db }));
vi.mock("../auth/context.js", async (orig) => ({ ...(await orig<typeof import("../auth/context.js")>()), workspaceContextFor: vi.fn() }));

const { workspaceContextFor } = await import("../auth/context.js");
const { callerFor, resolvingTo, inWorkspace, callToolAs } = await import("./testing/call.js");
import type { Ctx } from "../auth/context.js";
import { agentCtx, nodeSettings, personCtx, recordingJobs } from "../testing/ctx.js";

const mcpEnv = () => ({ surface: "mcp" as const, env: { settings: nodeSettings(), jobs: recordingJobs() } });

async function events(args: Record<string, unknown>, ctx: Ctx = agentCtx(mcpEnv())) {
  vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctx));
  const out = await callToolAs(callerFor(ctx), "events", inWorkspace(ctx.workspaceId, "events", args));
  expect(out.isError, out.text).toBe(false);
  return db.listWorkspaceEvents.mock.calls.at(-1)![1] as { types?: string[]; agentAlias?: string; selfActor?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.getWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "io", agent_instructions: "" });
  db.listWorkspacesForUser.mockResolvedValue([{ workspace_id: "ws1", name: "io", role: "member" }]);
  db.latestWorkspaceEventId.mockResolvedValue(3);
  db.listWorkspaceEvents.mockResolvedValue([]);
});

describe("events with mine", () => {
  it("asks for decisions on the agent's runs and replies in its threads by default", async () => {
    expect(await events({ mine: true })).toMatchObject({
      agentAlias: "agent-1",
      selfActor: "agent:agent-1",
      types: ["run.decided", "run.reverted", "run.reopened", "comment.added"],
    });
  });

  it("leaves out a person's own replies by the actor their events carry", async () => {
    expect(await events({ mine: true }, personCtx({ alias: "u_ada", ...mcpEnv() }))).toMatchObject({ agentAlias: "u_ada", selfActor: "user:u_ada" });
  });

  it("keeps the types the agent names", async () => {
    expect(await events({ mine: true, types: ["comment.added"] })).toMatchObject({ agentAlias: "agent-1", types: ["comment.added"] });
  });

  it("reads everyone's events without it", async () => {
    const query = await events({});
    expect(query.agentAlias).toBeUndefined();
    expect(query.selfActor).toBeUndefined();
    expect(query.types).toBeUndefined();
  });
});
