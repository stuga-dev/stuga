import { describe, expect, it } from "vitest";
import { mentionQueryAt } from "./mention-query";

describe("mentionQueryAt", () => {
  it("finds the @query the caret ends", () => {
    expect(mentionQueryAt("hi @ad")).toEqual({ start: 3, query: "ad" });
    expect(mentionQueryAt("@")).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("(@liv")).toEqual({ start: 1, query: "liv" });
  });

  it("allows one space, for a full name", () => {
    expect(mentionQueryAt("ping @Ada Lo")).toEqual({ start: 5, query: "Ada Lo" });
    expect(mentionQueryAt("ping @Ada Lovelace said")).toBeNull();
  });

  it("ignores an email address and an @ the caret has left", () => {
    expect(mentionQueryAt("mail ada@example")).toBeNull();
    expect(mentionQueryAt("@ada ")).toEqual({ start: 0, query: "ada " });
    expect(mentionQueryAt("@ada  ")).toBeNull();
  });
});
