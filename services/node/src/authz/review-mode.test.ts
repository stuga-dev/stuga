import { describe, expect, it } from "vitest";
import type { DocRow } from "@stuga/db";
import { SHARED_NOTES_REASON, agentFolderReviewMode, agentReviewMode, effectiveReviewLevel, resolveReviewMode } from "./review-mode.js";
import type { Ctx } from "../auth/context.js";

const doc = (mode: DocRow["agent_mode"]) => ({ agent_mode: mode }) as DocRow;
const ctx = (isAgent: boolean) => ({ isAgent }) as Ctx;

describe("resolveReviewMode", () => {
  it("parks an agent's proposal on a `review` document", () => {
    expect(resolveReviewMode(ctx(true), doc("review"))).toMatchObject({ mode: "review" });
  });

  it("lands it on an `auto` document", () => {
    const out = resolveReviewMode(ctx(true), doc("auto"));
    expect(out.mode).toBe("auto");
    expect(out.reason).toContain("let AI edits apply directly");
  });

  it("a human session parks whatever the document says", () => {
    expect(resolveReviewMode(ctx(false), doc("auto"))).toMatchObject({ mode: "review", reason: "a human session" });
    expect(resolveReviewMode(ctx(false), doc("review"))).toMatchObject({ mode: "review" });
  });
});

describe("an item in a person's My notes shared beyond them", () => {
  const notes = (mode: DocRow["agent_mode"], shared: boolean) =>
    ({ agent_mode: null, folder_agent_mode: mode, database_agent_mode: null, notes_shared: shared }) as DocRow;

  it("waits for review for every agent, though My notes applies AI edits directly", () => {
    const out = resolveReviewMode(ctx(true), notes("auto", true));
    expect(out.mode).toBe("review");
    expect(out.reason).toBe(SHARED_NOTES_REASON);
    expect(agentReviewMode(notes("auto", true)).mode).toBe("review");
    expect(effectiveReviewLevel(notes("auto", true))).toBe("review");
  });

  it("applies directly while only its person can read it", () => {
    expect(agentReviewMode(notes("auto", false))).toMatchObject({ mode: "auto" });
    expect(effectiveReviewLevel(notes("auto", false))).toBe("auto");
  });

  it("keeps a stricter level its person set", () => {
    expect(agentReviewMode(notes("colleague", true))).toMatchObject({ mode: "colleague", reason: "this document waits for a colleague's approval" });
  });

  it("raises a folder there the same way", () => {
    expect(agentFolderReviewMode({ agent_mode: "auto", parent_agent_mode: null, notes_shared: true })).toBe("review");
    expect(agentFolderReviewMode({ agent_mode: "auto", parent_agent_mode: null, notes_shared: false })).toBe("auto");
    expect(agentFolderReviewMode({ agent_mode: null, parent_agent_mode: "auto" })).toBe("auto");
  });
});
