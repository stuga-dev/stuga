import { describe, it, expect } from "vitest";
import type { AgentRunHunk, AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { turnOutcome } from "./turn-outcome";

function hunk(id: string, status: AgentRunHunk["status"], feedback?: AgentRunHunk["feedback"]): AgentRunHunk {
  return { id, old_string: "a", new_string: "b", status, review: "review", ...(feedback ? { feedback } : {}) };
}

function run(hunks: AgentRunHunk[], over: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id: "run_a",
    doc_id: "d1",
    source: "panel",
    agent: "AI co-author",
    agent_alias: "panel:liv",
    reviewer: "liv",
    status: "open",
    hunks,
    acknowledged: false,
    auto_applied: false,
    review_mode: "review",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("what became of a turn's changes", () => {
  it("counts only this turn's changes still waiting", () => {
    const r = run([hunk("h1", "pending"), hunk("h2", "pending"), hunk("h3", "accepted")]);
    expect(turnOutcome(r, ["h2", "h3"])).toEqual({ kind: "pending", count: 1 });
  });

  it("follows the decision once nothing waits", () => {
    expect(turnOutcome(run([hunk("h1", "accepted"), hunk("h2", "accepted")]), ["h1", "h2"])).toEqual({ kind: "accepted" });
    expect(turnOutcome(run([hunk("h1", "rejected")]), ["h1"])).toEqual({ kind: "rejected" });
    expect(turnOutcome(run([hunk("h1", "accepted"), hunk("h2", "rejected")]), ["h1", "h2"])).toEqual({ kind: "mixed", accepted: 1, rejected: 1 });
  });

  it("never calls a change that could not apply rejected", () => {
    expect(turnOutcome(run([hunk("h1", "accepted"), hunk("h2", "conflict")]), ["h1", "h2"])).toEqual({ kind: "accepted" });
    expect(turnOutcome(run([hunk("h1", "auto_applied"), hunk("h2", "conflict")], { auto_applied: true }), ["h1", "h2"])).toEqual({
      kind: "applied",
      count: 1,
    });
    // Accept pressed on a change the document had moved past: nothing to report but what the turn said.
    expect(turnOutcome(run([hunk("h1", "conflict")]), ["h1"])).toBeNull();
  });

  it("calls a rejection a later turn revised replaced", () => {
    const fb = { id: "fb_1", note: "Shorter.", decided_by: "liv", decided_at: 1 };
    expect(turnOutcome(run([hunk("h1", "rejected", fb)]), ["h1"], new Set(["fb_1"]))).toEqual({ kind: "replaced" });
    expect(turnOutcome(run([hunk("h1", "rejected", { ...fb, addressed_at: 2 })]), ["h1"])).toEqual({ kind: "replaced" });
  });

  it("reports changes applied at once, and their revert", () => {
    expect(turnOutcome(run([hunk("h1", "auto_applied")], { auto_applied: true }), ["h1"])).toEqual({ kind: "applied", count: 1 });
    expect(turnOutcome(run([hunk("h1", "auto_applied")], { auto_applied: true, reverted: true, status: "expired" }), ["h1"])).toEqual({
      kind: "reverted",
    });
  });

  it("has nothing to say without the run or its changes", () => {
    expect(turnOutcome(undefined, ["h1"])).toBeNull();
    expect(turnOutcome(run([hunk("h1", "pending")]), undefined)).toBeNull();
    expect(turnOutcome(run([], { hunks_truncated: true }), ["h1"])).toBeNull();
  });
});
