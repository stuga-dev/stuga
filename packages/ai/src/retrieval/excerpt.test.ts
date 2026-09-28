import { describe, expect, it } from "vitest";
import { excerpts, termsOf } from "./excerpt.js";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Filler sentence number ${i} about nothing in particular.`).join(" ");

describe("termsOf", () => {
  it("lowercases words and drops single letters", () => {
    expect(termsOf("A Snowflake UNPIVOT, x 7").map((t) => t.term)).toEqual(["snowflake", "unpivot", "7"]);
  });

  it("pairs characters in scripts written without spaces, with their offsets", () => {
    expect(termsOf("个人信息 GDPR")).toEqual([
      { term: "个人", at: 0 },
      { term: "人信", at: 1 },
      { term: "信息", at: 2 },
      { term: "gdpr", at: 5 },
    ]);
  });
});

describe("excerpts", () => {
  it("reads a passage that fits whole", () => {
    expect(excerpts("breach", ["  A short passage about a breach.  "], 100)).toEqual(["A short passage about a breach."]);
  });

  it("reads the start when no term matches", () => {
    const text = filler(40);
    expect(excerpts("regulator deadline", [text], 200)[0]).toBe(text.slice(0, 200).trim());
  });

  it("finds the terms deep in a long passage and opens on their sentence", () => {
    const text = `${filler(40)} Report the breach to the regulator within 72 hours. ${filler(10)}`;
    const [out] = excerpts("breach regulator 72 hours", [text, filler(5)], 200);
    expect(out).toMatch(/^… Report the breach to the regulator within 72 hours\./);
    expect(out!.length).toBeLessThanOrEqual(202);
  });

  it("keeps the start when it matches as well as any later window", () => {
    const text = `Breach notices go to the regulator. ${filler(40)} The regulator hears of a breach again.`;
    expect(excerpts("breach regulator", [text], 200)[0]!.startsWith("Breach notices")).toBe(true);
  });

  it("weighs a term every candidate shares below a rarer one", () => {
    const common = "passage";
    const text = `${common} ${filler(30)} FLATTEN turns columns into rows. ${filler(30)} ${common} ${common}`;
    const others = Array.from({ length: 5 }, () => `${common} ${filler(2)}`);
    const [out] = excerpts(`${common} flatten`, [text, ...others], 200);
    expect(out).toContain("FLATTEN turns columns into rows.");
  });

  it("finds a Chinese phrase without spaces", () => {
    const text = `${"无关的内容。".repeat(80)}个人信息处理者应当立即采取补救措施。${"其他内容。".repeat(40)}`;
    expect(excerpts("个人信息 补救措施", [text], 100)[0]).toMatch(/^… 个人信息处理者应当立即采取补救措施/);
  });
});
