import { describe, expect, it } from "vitest";
import { agentCtx, personCtx, recordingJobs, type CtxOverrides } from "../testing/ctx.js";
import { recordEvent } from "./record.js";

describe("recordEvent", () => {
  it.each<[string, (over: CtxOverrides) => ReturnType<typeof personCtx>, CtxOverrides, string, string]>([
    ["a person", personCtx, { alias: "u_liv" }, "user:u_liv", "human"],
    ["an agent key", agentCtx, { alias: "agent-7" }, "agent:agent-7", "agent"],
    ["a person's co-author", agentCtx, { alias: "panel:u_liv", onBehalfOf: "u_liv" }, "panel:u_liv", "agent"],
  ])("names %s as run events name it", (_label, make, over, actor, actorKind) => {
    const jobs = recordingJobs();
    recordEvent(make({ ...over, env: { jobs } }), "comment.added", "d1", { num: 1 });
    expect(jobs.sent()).toEqual([
      { kind: "event", workspaceId: "ws1", type: "comment.added", docId: "d1", actor, actorKind, payload: { num: 1 } },
    ]);
  });
});
