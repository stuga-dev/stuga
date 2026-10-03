import { describe, expect, it } from "vitest";
import { RUN_FEEDBACK_EXCERPT_CHARS, RUN_FEEDBACK_NOTE_MAX_CHARS, RUN_IDLE_MS } from "./limits.js";
import {
  agentActorOf,
  clampRunLimit,
  closedStatus,
  feedbackExcerpt,
  newFeedbackId,
  newRunId,
  parseDecisionNote,
  parseReviewMode,
  runIsIdle,
  shouldCommit,
} from "./runs.js";

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

  it("commits only auto proposals that are not behind pending work", () => {
    expect(shouldCommit("auto", false)).toBe(true);
    expect(shouldCommit("review", false)).toBe(false);
    expect(shouldCommit("auto", true)).toBe(false);
  });

  it("takes a rejection's note trimmed, refuses one on an accept or past the limit, and reads blank as none", () => {
    expect(parseDecisionNote("reject", "  Keep it plain. ")).toEqual({ ok: true, note: "Keep it plain." });
    expect(parseDecisionNote("reject", "   ")).toEqual({ ok: true });
    expect(parseDecisionNote("accept", undefined)).toEqual({ ok: true });
    expect(parseDecisionNote("accept", "")).toEqual({ ok: true });
    expect(parseDecisionNote("accept", "Nice.")).toMatchObject({ ok: false });
    expect(parseDecisionNote("reject", 7)).toMatchObject({ ok: false });
    expect(parseDecisionNote("reject", "x".repeat(RUN_FEEDBACK_NOTE_MAX_CHARS))).toMatchObject({ ok: true });
    expect(parseDecisionNote("reject", "x".repeat(RUN_FEEDBACK_NOTE_MAX_CHARS + 1))).toMatchObject({ ok: false });
  });

  it("mints feedback ids of one shape and cuts long excerpts", () => {
    expect(newFeedbackId()).toMatch(/^fb_[0-9a-f]{12}$/);
    expect(feedbackExcerpt("short")).toBe("short");
    expect(feedbackExcerpt("x".repeat(RUN_FEEDBACK_EXCERPT_CHARS + 5))).toBe(`${"x".repeat(RUN_FEEDBACK_EXCERPT_CHARS)}…`);
  });
});
