import { describe, expect, it } from "vitest";
import { cutoffFor, queryStyle } from "./cutoff.js";

describe("queryStyle", () => {
  it("calls up to four words without a question mark a short query", () => {
    expect(queryStyle("sourdough starter")).toBe("short");
    expect(queryStyle("  how to feed starter ")).toBe("short");
    expect(queryStyle("how to feed a starter")).toBe("question");
    expect(queryStyle("starter?")).toBe("question");
    expect(queryStyle("酸种？")).toBe("question");
    expect(queryStyle("2024 2025")).toBe("short");
  });

  it("counts characters where words are not spaced: eight is short, nine a question", () => {
    expect(queryStyle("怎么恢复数据库备")).toBe("short");
    expect(queryStyle("怎么恢复数据库备份")).toBe("question");
    expect(queryStyle("サワー種の作り方")).toBe("short");
    expect(queryStyle("천연 발효종 만들기")).toBe("short");
  });
});

describe("cutoffFor", () => {
  it("picks the query's style, and nothing without a cutoff", () => {
    const c = { short: 0.34, question: 0.31 };
    expect(cutoffFor("tax deductions", c)).toBe(0.34);
    expect(cutoffFor("which deductions can I claim this year?", c)).toBe(0.31);
    expect(cutoffFor("tax deductions", null)).toBeNull();
  });
});
