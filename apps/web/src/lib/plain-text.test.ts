import { describe, expect, it } from "vitest";
import { plainTextProblem } from "./plain-text";

describe("plainTextProblem", () => {
  it("passes a name people can read, in any script, joiners included", () => {
    // An emoji ZWJ sequence, and the non-joiner Persian spelling needs.
    for (const value of ["Liv’s Mac", "家里的 Mac mini", "\u{1F469}\u200d\u{1F4BB} Studio", "می\u200cخواهم"]) {
      expect(plainTextProblem(value, 80), value).toBeNull();
    }
  });

  it("refuses a value that would read as blank", () => {
    for (const value of ["\u200b", "\u200b\u2060", "\u2800", "\u0301"]) {
      expect(plainTextProblem(value, 80), JSON.stringify(value)).toBe("Use at least one visible character.");
    }
  });

  it("refuses control characters, the line and paragraph separators, and direction overrides", () => {
    for (const value of ["Studio\u0007", "Studio\u2028", "Studio\u2029", "\u202eoidutS"]) {
      expect(plainTextProblem(value, 80), JSON.stringify(value)).toBe("Remove the hidden control characters.");
    }
  });

  it("refuses a value past the limit", () => {
    expect(plainTextProblem("x".repeat(80), 80)).toBeNull();
    expect(plainTextProblem("x".repeat(81), 80)).toBe("Use up to 80 characters.");
  });
});
