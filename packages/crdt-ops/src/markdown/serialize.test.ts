/**
 * The serializer's output is read only at its end, wherever that end falls: in a
 * body of any length the escapes that look back at what was written still apply,
 * and no look reads the whole output, which made serializing quadratic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { docToMarkdown, getStugaSchema, markdownToDoc } from "../index.js";

const schema = getStugaSchema();
const roundTrip = (md: string): string => docToMarkdown(markdownToDoc(md, schema));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("docToMarkdown", () => {
  it("escapes a `!` before a link, and a list marker after a hard break, wherever they fall in the output", () => {
    for (let n = 0; n <= 200; n++) {
      const lead = "x".repeat(n);
      for (const md of [`${lead}\\![a link](https://example.com)`, `${lead}\\\n1\\. not a list`, `Intro\n\n${lead}\\\n1\\. not a list`]) {
        expect(roundTrip(md), JSON.stringify(md)).toBe(md);
      }
    }
  });

  it("looks back at no more than the output's last characters, however long the body", () => {
    const md = Array.from({ length: 5_000 }, (_, i) => (i % 3 === 0 ? `* item ${i}` : `Paragraph ${i} with some words.`)).join("\n\n");
    const test = RegExp.prototype.test;
    let longest = 0;
    vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, input: string) {
      if (this.source.endsWith("$")) longest = Math.max(longest, String(input).length);
      return test.call(this, input);
    });
    const out = roundTrip(md);
    expect(out.length).toBeGreaterThan(100_000);
    expect(longest).toBeLessThan(200);
  });
});
