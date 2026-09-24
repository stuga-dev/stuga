import { describe, it, expect } from "vitest";
import {
  chunkText,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  headingAwareChunk,
  chunkEmbedInput,
  SECTION_MAX,
  HEADINGLESS_TARGET,
} from "./chunk.js";

describe("chunkText", () => {
  it("returns [] for blank/whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t ")).toEqual([]);
  });

  it("returns a single trimmed chunk for short text", () => {
    expect(chunkText("  hello world  ")).toEqual(["hello world"]);
  });

  it("splits long text into multiple chunks, each within the size cap", () => {
    // 60 paragraphs of ~100 chars → well over CHUNK_SIZE.
    const text = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${"x".repeat(90)}`).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Allow overlap to push a chunk slightly over the raw cap, but not unboundedly.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE + CHUNK_OVERLAP + 5);
  });

  it("prefers paragraph boundaries (no chunk starts mid-sentence when paragraphs fit)", () => {
    const paras = Array.from({ length: 10 }, (_, i) => `Para${i}. ` + "word ".repeat(80));
    const chunks = chunkText(paras.join("\n\n"));
    // Every chunk should be non-empty and trimmed (no leading/trailing whitespace).
    for (const c of chunks) {
      expect(c).toBe(c.trim());
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it("carries overlap between adjacent chunks (continuity)", () => {
    // Distinct sentinel words far apart so we can detect overlap carry-over.
    const body = Array.from({ length: 80 }, (_, i) => `token${i}`).join(". ") + ".";
    const chunks = chunkText(body, 200, 60);
    expect(chunks.length).toBeGreaterThan(1);
    // The tail of chunk i should reappear at the head of chunk i+1 for some token.
    let sawOverlap = false;
    for (let i = 1; i < chunks.length; i++) {
      const prevTailToken = chunks[i - 1]!.split(/\s+/).pop()!.replace(/\W/g, "");
      if (prevTailToken && chunks[i]!.includes(prevTailToken)) sawOverlap = true;
    }
    expect(sawOverlap).toBe(true);
  });

  it("hard-splits a single token longer than the size cap (no infinite recursion)", () => {
    const giant = "a".repeat(CHUNK_SIZE * 3 + 17);
    const chunks = chunkText(giant);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Reassembled content covers the whole input (no data dropped).
    expect(chunks.join("").replace(/\s/g, "").length).toBeGreaterThanOrEqual(giant.length);
  });

  it("respects a custom size + overlap", () => {
    const text = "sentence one. sentence two. sentence three. sentence four. sentence five.";
    const chunks = chunkText(text, 30, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30 + 10 + 5);
  });

  it("exports sane defaults", () => {
    expect(CHUNK_SIZE).toBe(2000);
    expect(CHUNK_OVERLAP).toBe(200);
  });
});

describe("headingAwareChunk", () => {
  it("returns [] for blank input", () => {
    expect(headingAwareChunk("")).toEqual([]);
    expect(headingAwareChunk("  \n\t ")).toEqual([]);
  });

  it("splits on the heading tree — one chunk per section, heading line kept", () => {
    const md = "# A\n\nbody of A\n\n# B\n\nbody of B";
    const out = headingAwareChunk(md);
    expect(out).toHaveLength(2);
    expect(out[0]!.headingPath).toBe("A");
    expect(out[0]!.content.startsWith("# A")).toBe(true);
    expect(out[0]!.content).toContain("body of A");
    expect(out[1]!.headingPath).toBe("B");
    expect(out[1]!.content).toContain("body of B");
  });

  it("records the full nested heading_path", () => {
    const md = "# Overview\n\nintro\n\n## Geophysics\n\ng-body\n\n### Internal heat\n\nih-body";
    const out = headingAwareChunk(md);
    const ih = out.find((c) => c.content.includes("ih-body"))!;
    expect(ih.headingPath).toBe("Overview > Geophysics > Internal heat");
    // A sibling deeper heading pops the stack correctly.
    const geo = out.find((c) => c.content.includes("g-body"))!;
    expect(geo.headingPath).toBe("Overview > Geophysics");
  });

  it("subdivides an oversize section, all sub-chunks sharing the heading_path", () => {
    const big = Array.from({ length: 800 }, (_, i) => `Sentence ${i} about the topic.`).join(" ");
    const md = `## Big\n\n${big}`;
    expect(md.length).toBeGreaterThan(SECTION_MAX);
    const out = headingAwareChunk(md);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.headingPath).toBe("Big");
      expect(c.content.length).toBeLessThanOrEqual(SECTION_MAX + 10);
    }
  });

  it("keeps distinct headings as SEPARATE chunks (no merge — preserves citation precision)", () => {
    const md = ["# T1", "x", "# T2", "y", "# T3", "z"].join("\n\n");
    const out = headingAwareChunk(md);
    // Each distinct heading is its own chunk with its own path — NOT merged.
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.headingPath)).toEqual(["T1", "T2", "T3"]);
  });

  it("falls back to paragraph aggregation for headingless prose (path='')", () => {
    const prose = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} with some filler words here.`).join("\n\n");
    expect(prose).not.toContain("#");
    const out = headingAwareChunk(prose);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.headingPath).toBe("");
      expect(c.content.length).toBeLessThanOrEqual(HEADINGLESS_TARGET + 10);
    }
  });

  it("does NOT treat a # line inside a fenced code block as a heading", () => {
    const md = "# Real Heading\n\nintro\n\n```python\n# this is a comment, not a heading\nx = 1\n```\n\nmore";
    const out = headingAwareChunk(md);
    // Only one real heading → one section (the code # stays inside it).
    expect(out).toHaveLength(1);
    expect(out[0]!.headingPath).toBe("Real Heading");
    expect(out[0]!.content).toContain("# this is a comment");
  });

  it("treats text before the first heading as a preamble chunk (path='')", () => {
    const md = "Some intro text before any heading.\n\n# First\n\nbody";
    const out = headingAwareChunk(md);
    expect(out[0]!.headingPath).toBe("");
    expect(out[0]!.content).toContain("intro text");
    expect(out.some((c) => c.headingPath === "First")).toBe(true);
  });

  it("exports sane section bounds", () => {
    expect(HEADINGLESS_TARGET).toBeLessThanOrEqual(SECTION_MAX);
  });

  it("closes a fence only on the same character with at least the opener's length", () => {
    const md = [
      "# Real",
      "",
      "````md",
      "```",
      "# inside a four-backtick fence",
      "```",
      "~~~",
      "# still inside",
      "````",
      "",
      "# After",
      "",
      "tail",
    ].join("\n");
    const out = headingAwareChunk(md);
    expect(out.map((c) => c.headingPath)).toEqual(["Real", "After"]);
    expect(out[0]!.content).toContain("# still inside");
  });
});

// The dedup hash covers exactly this string, so unchanged sections keep their vectors across edits.
describe("chunkEmbedInput", () => {
  it("prefixes title only for chunk 0, heading path for all", () => {
    expect(chunkEmbedInput("T", "A > B", "body", true)).toBe("T\n\nA > B\n\nbody");
    expect(chunkEmbedInput("T", "A > B", "body", false)).toBe("A > B\n\nbody");
    expect(chunkEmbedInput("T", "", "body", false)).toBe("body");
    expect(chunkEmbedInput("T", null, "body", false)).toBe("body");
    expect(chunkEmbedInput("T", undefined, "body", true)).toBe("T\n\nbody");
  });

  it("a one-section edit changes ONLY the edited section's embed input", () => {
    const before = "# Intro\n\nintro body\n\n# Middle\n\nold middle\n\n# End\n\nend body";
    const after = "# Intro\n\nintro body\n\n# Middle\n\nNEW middle\n\n# End\n\nend body";
    const inputsOf = (md: string) => {
      const pieces = headingAwareChunk(md);
      return pieces.map((p, i) => chunkEmbedInput("Doc Title", p.headingPath, p.content, i === 0));
    };
    const a = inputsOf(before);
    const b = inputsOf(after);
    expect(a.length).toBe(3);
    expect(b.length).toBe(3);
    // Only the "Middle" section differs; Intro (chunk 0, title-prefixed) and End
    // are byte-identical → their vectors are reusable across the edit.
    expect(a.map((x, i) => x !== b[i])).toEqual([false, true, false]);
  });

  it("a title change flips ONLY chunk 0's embed input", () => {
    const md = "# Intro\n\nintro\n\n# End\n\nend";
    const pieces = headingAwareChunk(md);
    const a = pieces.map((p, i) => chunkEmbedInput("Old Title", p.headingPath, p.content, i === 0));
    const b = pieces.map((p, i) => chunkEmbedInput("New Title", p.headingPath, p.content, i === 0));
    expect(a.map((x, i) => x !== b[i])).toEqual([true, false]);
  });
});
