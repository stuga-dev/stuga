import { describe, expect, it } from "vitest";
import { completionPrefix } from "./search.js";

describe("completionPrefix", () => {
  it("splits off the last word, lowercased, from the finished ones", () => {
    expect(completionPrefix("  sure WHE ")).toEqual({ head: "sure", prefix: "whe" });
    expect(completionPrefix("notif")).toEqual({ head: "", prefix: "notif" });
  });

  it("takes three letters, or two Hangul syllables", () => {
    expect(completionPrefix("wh")).toBeNull();
    expect(completionPrefix("회의")).toEqual({ head: "", prefix: "회의" });
  });

  it("skips a word in a script written without spaces, or with punctuation in it", () => {
    expect(completionPrefix("数据保护")).toBeNull();
    expect(completionPrefix("データ")).toBeNull();
    expect(completionPrefix("e-mail")).toBeNull();
    expect(completionPrefix("(2026)")).toBeNull();
  });
});
