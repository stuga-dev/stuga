import { describe, expect, it } from "vitest";
import { summarizeHunk } from "./hunk-review";

describe("summarizeHunk", () => {
  it("shows a reword as before → after, with the line it sits in", () => {
    expect(summarizeHunk({ old_string: "* 04/05 — Samples arrive (Tom)", new_string: "* 5 April — Samples arrive (Tom)" })).toMatchObject({
      kind: "change",
      text: "04/05 → 5 April",
      context: "5 April — Samples arrive (Tom)",
    });
  });

  it("names the paragraph a removed sentence came from", () => {
    const summary = summarizeHunk({ old_string: "Launch in London. Dates are day first.", new_string: "Launch in London." });
    expect(summary).toMatchObject({ kind: "remove", text: "Dates are day first.", context: "Launch in London. Dates are day first." });
  });

  it("reads a removed section as its words, without Markdown markers", () => {
    const summary = summarizeHunk({ old_string: "## Scope\n\n* A booking flow\n\n* Menu pages\n\nNext.", new_string: "Next." });
    expect(summary.text).toBe("Scope A booking flow Menu pages");
  });

  it("leaves out the context when the change is the whole line", () => {
    const heading = summarizeHunk({ old_string: "", new_string: "## Budget" });
    expect([heading.text, heading.context]).toEqual(["Budget", undefined]);
    expect(summarizeHunk({ old_string: "", new_string: "A new paragraph." }).context).toBeUndefined();
  });
});
