import { describe, expect, it } from "vitest";
import type { AgentRunHunk } from "@stuga/protocol/wire/doc-socket";
import { approveBlock, cardChanges, citedNumbers, footnoteDefinitions, withoutDefinitions } from "./review-card";

const hunk = (id: string, old_string: string, new_string: string, status: AgentRunHunk["status"] = "pending"): AgentRunHunk => ({
  id,
  old_string,
  new_string,
  status,
  review: "colleague",
});

const BASELINE = [
  "# Leave policy",
  "",
  "Everyone gets leave.",
  "",
  "## Annual leave",
  "",
  "Ten days a year, taken in agreement with the team.",
  "",
  "## Sick leave",
  "",
  "Tell your lead before ten.",
  "",
].join("\n");

describe("cardChanges", () => {
  it("shows each change in its paragraph, under the section it is in", () => {
    const [change] = cardChanges(BASELINE, [hunk("h1", "Ten days", "Twelve days")]);
    expect(change).toMatchObject({
      before: "Ten days a year, taken in agreement with the team.",
      after: "Twelve days a year, taken in agreement with the team.",
      section: "Annual leave",
      sources: [],
    });
  });

  it("reads each change against the ones before it, as the agent proposed them", () => {
    const changes = cardChanges(BASELINE, [hunk("h1", "Ten days", "Twelve days"), hunk("h2", "Twelve days a year", "Twelve days a calendar year")]);
    expect(changes[1]).toMatchObject({
      before: "Twelve days a year, taken in agreement with the team.",
      after: "Twelve days a calendar year, taken in agreement with the team.",
      section: "Annual leave",
    });
  });

  it("puts an addition at the end, under the last section", () => {
    const [change] = cardChanges(BASELINE, [hunk("h1", "", "\n## Parental leave\n\nSixteen weeks.\n")]);
    expect(change!.before).toBe("");
    expect(change!.after).toContain("Sixteen weeks.");
    expect(change!.section).toBe("Sick leave");
  });

  it("stands a change alone when its place is not found, or there is no document to read it in", () => {
    expect(cardChanges(BASELINE, [hunk("h1", "Fourteen days", "Fifteen days")])[0]).toMatchObject({ before: "Fourteen days", after: "Fifteen days", section: null });
    expect(cardChanges(null, [hunk("h1", "Ten days", "Twelve days")])[0]).toMatchObject({ before: "Ten days", after: "Twelve days", section: null });
  });

  it("lists what a change cites: the run's citations, else the definitions written in the text", () => {
    const changes = cardChanges(BASELINE + "\n[^1]: [Handbook — Leave](/doc/d_handbook) \"Twelve days from 2027\"\n", [
      hunk("h1", "Ten days", "Twelve days[^1][^2]"),
      hunk("h2", "Tell your lead before ten.", "Tell your lead before nine.[^3]\n\n[^3]: The team meeting, 3 March"),
    ], [{ n: 2, doc_id: "d_policy", title: "HR policy", heading_path: "Leave", content: "Twelve days." }]);
    expect(changes[0]!.sources).toEqual([
      { n: 1, title: "Handbook — Leave", docId: "d_handbook", excerpt: "Twelve days from 2027" },
      { n: 2, title: "HR policy — Leave", docId: "d_policy", excerpt: "Twelve days." },
    ]);
    expect(changes[1]!.sources).toEqual([{ n: 3, title: "The team meeting, 3 March", docId: null, excerpt: null }]);
    // The definitions are listed as sources, not shown as text.
    expect(changes[1]!.after).toBe("Tell your lead before nine.[^3]");
  });
});

describe("footnotes", () => {
  it("reads definitions and markers, each marker once and a definition never as a marker", () => {
    const md = "A[^2] and B[^1] and A again[^2].\n\n[^1]: One\n[^2]: Two";
    expect(citedNumbers(md)).toEqual([2, 1]);
    expect([...footnoteDefinitions(md)]).toEqual([
      [1, "One"],
      [2, "Two"],
    ]);
    expect(withoutDefinitions(md)).toBe("A[^2] and B[^1] and A again[^2].");
  });
});

describe("approveBlock", () => {
  const base = { me: "sam", reviewer: "liv", level: "colleague" as const, approverGroup: null, locked: false, pending: 2 };
  const you = (over: Partial<{ accept: boolean; reject: boolean; ack: boolean; waits_for: "colleague" | "nobody" | "group" }> = {}) => ({
    level: "colleague" as const,
    accept: false,
    reject: false,
    ack: false,
    ...over,
  });

  it("says nothing to whoever may approve, or when nothing waits", () => {
    expect(approveBlock({ ...base, you: you({ accept: true, reject: true }) })).toBeNull();
    expect(approveBlock({ ...base, you: you(), pending: 0 })).toBeNull();
  });

  it("tells whoever asked whom it waits for", () => {
    expect(approveBlock({ ...base, me: "liv", you: you({ reject: true, waits_for: "colleague" }) })).toEqual({ kind: "own", waitsFor: "colleague" });
    expect(approveBlock({ ...base, me: "liv", you: you({ reject: true, waits_for: "group" }) })).toEqual({ kind: "own", waitsFor: "group" });
  });

  it("tells anyone else which level decides it", () => {
    expect(approveBlock({ ...base, you: you() })).toEqual({ kind: "colleague", group: null });
    expect(approveBlock({ ...base, approverGroup: "group:legal", you: you() })).toEqual({ kind: "colleague", group: "group:legal" });
    expect(approveBlock({ ...base, level: "review", you: { ...you(), level: "review" } })).toEqual({ kind: "reviewer" });
  });

  it("asks to unlock a locked item first", () => {
    expect(approveBlock({ ...base, locked: true, you: you({ accept: true, reject: true }) })).toEqual({ kind: "locked" });
  });
});
