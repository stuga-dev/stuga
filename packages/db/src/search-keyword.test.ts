import { describe, expect, it } from "vitest";
import { withinOneEdit } from "./search-keyword.js";

describe("withinOneEdit", () => {
  it("takes one insertion, deletion, substitution or swap of neighbours", () => {
    expect(withinOneEdit("croisant", "croissant")).toBe(true);
    expect(withinOneEdit("croissant", "croisant")).toBe(true);
    expect(withinOneEdit("retentoin", "retention")).toBe(true);
    expect(withinOneEdit("budgte", "budget")).toBe(true);
    expect(withinOneEdit("plxn", "plan")).toBe(true);
    expect(withinOneEdit("plan", "plan")).toBe(true);
    expect(withinOneEdit("xlan", "plan")).toBe(true);
    expect(withinOneEdit("plans", "plan")).toBe(true);
  });

  it("refuses two edits, however they fall", () => {
    expect(withinOneEdit("quartely", "quaterly")).toBe(false);
    expect(withinOneEdit("budgte", "bduget")).toBe(false);
    expect(withinOneEdit("plan", "plains")).toBe(false);
    expect(withinOneEdit("abcd", "badc")).toBe(false);
    expect(withinOneEdit("abc", "cba")).toBe(false);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(withinOneEdit("𝒜bcd", "𝒜bce")).toBe(true);
    expect(withinOneEdit("𝒜bcd", "bcd")).toBe(true);
  });
});
