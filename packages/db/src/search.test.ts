import { describe, expect, it } from "vitest";
import { completionPrefix, typoTolerant } from "./search.js";

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

describe("typoTolerant", () => {
  it("allows a typo when every word has four characters or more", () => {
    expect(typoTolerant("croisant")).toBe(true);
    expect(typoTolerant("croisant recipe")).toBe(true);
    expect(typoTolerant("Brot 2026")).toBe(true);
  });

  it("refuses a short word anywhere in the query, or a script written without spaces", () => {
    expect(typoTolerant("x")).toBe(false);
    expect(typoTolerant("ab")).toBe(false);
    expect(typoTolerant("croisant de")).toBe(false);
    expect(typoTolerant("煎饼")).toBe(false);
    expect(typoTolerant("人工智能技术")).toBe(false);
    expect(typoTolerant("データベース")).toBe(false);
    expect(typoTolerant("  ")).toBe(false);
  });
});
