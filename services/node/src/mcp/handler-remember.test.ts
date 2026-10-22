/**
 * Save to Stuga and Ask Stuga on /mcp: the `remember` tool runs the planner in the workspace a call
 * names, audited as a plan; the node offers both prompts, and a read-only connection only the one
 * that asks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  listWorkspacesForUser: vi.fn(),
}));

vi.mock("@stuga/db", async (orig) => ({ ...(await orig<typeof import("@stuga/db")>()), ...db }));
vi.mock("../auth/context.js", async (orig) => ({ ...(await orig<typeof import("../auth/context.js")>()), workspaceContextFor: vi.fn() }));
vi.mock("../agents/remember.js", () => ({ planRemember: vi.fn() }));

const { workspaceContextFor } = await import("../auth/context.js");
const { planRemember } = await import("../agents/remember.js");
const { callerFor, resolvingTo, inWorkspace, callToolAs, mcpRequest } = await import("./testing/call.js");
import { REMEMBER_NEXT } from "@stuga/agent-surface/render/remember";
import { agentCtx, nodeSettings, readOnlyKeyCtx, recordingJobs } from "../testing/ctx.js";

const PLAN = {
  user: { name: "Liv", username: "liv" },
  points: [
    {
      index: 0,
      text: "Refunds over 300 euros need finance approval.",
      topic: "Refunds",
      source: "team meeting 2026-10-20",
      candidates: [],
      already_saved: [],
      possibly_replaces: [],
    },
  ],
  home: {
    folder_id: "f_home",
    title: "My notes",
    created: true,
    shared: false,
    review: { mode: "auto", reason: "AI edits to pages in My notes apply directly" },
    pages: [],
  },
  instructions: [],
  semantic: false,
  degraded: false,
};

const mcpEnv = () => ({ surface: "mcp" as const, env: { settings: nodeSettings(), jobs: recordingJobs() } });

beforeEach(() => {
  vi.clearAllMocks();
  db.getWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "io", agent_instructions: "" });
  db.listWorkspacesForUser.mockResolvedValue([{ workspace_id: "ws1", name: "io", role: "member" }]);
  vi.mocked(planRemember).mockResolvedValue(PLAN as never);
});

describe("remember on /mcp", () => {
  it("plans in the workspace the call names, and audits the call as a plan", async () => {
    const ctx = agentCtx(mcpEnv());
    vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctx));
    const out = await callToolAs(
      callerFor(ctx),
      "remember",
      inWorkspace("ws1", "remember", { points: [{ text: " Refunds over 300 euros need finance approval.", topic: "Refunds", source: " team meeting 2026-10-20 " }, { text: "Sam owns billing.", source: " " }] }),
    );
    expect(out.isError, out.text).toBe(false);
    expect(JSON.parse(out.text)).toEqual({ ...PLAN, next: REMEMBER_NEXT });
    // Trimmed, and a blank topic or source left out.
    expect(vi.mocked(planRemember).mock.calls[0]![1]).toEqual([
      { text: "Refunds over 300 euros need finance approval.", topic: "Refunds", source: "team meeting 2026-10-20" },
      { text: "Sam owns billing." },
    ]);
    const jobs = (ctx.env as unknown as { jobs: ReturnType<typeof recordingJobs> }).jobs;
    expect(jobs.audits()).toEqual([expect.objectContaining({ action: "mcp.remember.plan", workspaceId: "ws1", status: "ok" })]);
  });
});

describe("the prompts on /mcp", () => {
  it("offers Save to Stuga and Ask Stuga, each in the person's voice", async () => {
    const caller = callerFor(agentCtx(mcpEnv()));
    const listed = (await mcpRequest(caller, "prompts/list")).result as { prompts: Array<{ name: string; title: string }> };
    expect(listed.prompts.map((p) => [p.name, p.title])).toEqual([
      ["save", "Save to Stuga"],
      ["ask", "Ask Stuga"],
    ]);
    const got = (await mcpRequest(caller, "prompts/get", { name: "save", arguments: { text: "Sam owns billing." } })).result as {
      messages: Array<{ role: string; content: { text: string } }>;
    };
    expect(got.messages).toEqual([{ role: "user", content: { type: "text", text: "Save to Stuga: Sam owns billing." } }]);
  });

  it("offers a read-only connection only the prompt that asks", async () => {
    const caller = callerFor(readOnlyKeyCtx(mcpEnv()));
    const listed = (await mcpRequest(caller, "prompts/list")).result as { prompts: Array<{ name: string }> };
    expect(listed.prompts.map((p) => p.name)).toEqual(["ask"]);
  });
});
