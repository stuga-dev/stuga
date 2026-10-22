// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { floorsOf } from "./ReviewLevelDialog";

describe("floorsOf", () => {
  it("says the folder's level, and nothing a folder's owner could not go below", () => {
    expect(floorsOf({ folder: "colleague", database: null, notes: null })).toEqual({
      lines: ["Its folder is at “Reviewed by a colleague”."],
      hard: null,
    });
  });

  it("holds a row page to its database and an item shared out of My notes to review, as the node does", () => {
    expect(floorsOf({ folder: "review", database: "colleague", notes: null })).toEqual({
      lines: ["Its folder is at “Reviewed by whoever asked the AI”.", "Its database is at “Reviewed by a colleague”, and its pages are never looser."],
      hard: "colleague",
    });
    expect(floorsOf({ folder: "auto", database: null, notes: "review" })).toEqual({
      lines: ["Its folder is at “AI edits apply directly”.", "Shared from My notes, so at least “Reviewed by whoever asked the AI”."],
      hard: "review",
    });
    expect(floorsOf(null)).toEqual({ lines: [], hard: null });
  });
});
