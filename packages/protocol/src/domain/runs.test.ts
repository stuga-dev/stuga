import { describe, expect, it } from "vitest";
import { RUN_IDLE_MS } from "./limits.js";
import { agentActorOf, clampRunLimit, closedStatus, newRunId, parseReviewMode, runIsIdle, shouldCommit } from "./runs.js";

describe("run ledger rules", () => {
  it("mints run ids of one shape", () => {
    expect(newRunId()).toMatch(/^run_[0-9a-f]{12}$/);
    expect(newRunId()).not.toBe(newRunId());
  });

  it("names API-key agents as agent principals and leaves namespaced aliases alone", () => {
    expect(agentActorOf("agent-7")).toBe("agent:agent-7");
    expect(agentActorOf("panel:liv")).toBe("panel:liv");
  });

  it("clamps a list limit and falls back on nonsense", () => {
    expect(clampRunLimit(null, 50, 20)).toBe(20);
    expect(clampRunLimit("abc", 50, 20)).toBe(20);
    expect(clampRunLimit("0", 50, 20)).toBe(1);
    expect(clampRunLimit("7.9", 50, 20)).toBe(7);
    expect(clampRunLimit("999", 50, 20)).toBe(50);
  });

  it("rolls a run over only once it has been quiet past the idle window", () => {
    expect(runIsIdle(0, RUN_IDLE_MS)).toBe(false);
    expect(runIsIdle(0, RUN_IDLE_MS + 1)).toBe(true);
  });

  it("closes as applied when anything landed, rejected otherwise", () => {
    expect(closedStatus([{ status: "rejected" }, { status: "auto_applied" }])).toBe("applied");
    expect(closedStatus([{ status: "accepted" }])).toBe("applied");
    expect(closedStatus([{ status: "rejected" }, { status: "conflict" }])).toBe("rejected");
    expect(closedStatus([])).toBe("rejected");
  });

  it("reads only an explicit auto as auto", () => {
    expect(parseReviewMode("auto")).toBe("auto");
    expect(parseReviewMode("AUTO")).toBe("review");
    expect(parseReviewMode(undefined)).toBe("review");
  });

  it("commits only auto proposals that are not the panel's and not behind pending work", () => {
    expect(shouldCommit("auto", "connector", false)).toBe(true);
    expect(shouldCommit("review", "connector", false)).toBe(false);
    expect(shouldCommit("auto", "panel", false)).toBe(false);
    expect(shouldCommit("auto", "stdio", true)).toBe(false);
  });
});
