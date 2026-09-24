import { describe, expect, it } from "vitest";
import { appendMarkdown } from "./append.js";

const DOC = "# Notes\n\nIntro line.\n\n## Log\n\n- first\n\n## Ideas\n\nSomething.\n";

describe("appendMarkdown", () => {
  it("appends after the last non-blank line of the document", () => {
    const out = appendMarkdown("Alpha.\n\n\n", "Beta.");
    expect(out).toEqual({ markdown: "Alpha.\n\nBeta.\n" });
  });

  it("fills an empty document", () => {
    expect(appendMarkdown("", "Hello")).toEqual({ markdown: "Hello\n" });
  });

  it("leaves the document alone for whitespace-only text", () => {
    expect(appendMarkdown(DOC, "  \n")).toEqual({ markdown: DOC });
  });

  it("appends at the end of a heading's section, before the next heading", () => {
    const out = appendMarkdown(DOC, "More text.", "Log");
    expect(out).toEqual({
      markdown: "# Notes\n\nIntro line.\n\n## Log\n\n- first\n\nMore text.\n\n## Ideas\n\nSomething.\n",
    });
  });

  it("a list item appended to a list joins it rather than starting a loose one", () => {
    expect(appendMarkdown(DOC, "- second", "Log")).toEqual({
      markdown: "# Notes\n\nIntro line.\n\n## Log\n\n- first\n- second\n\n## Ideas\n\nSomething.\n",
    });
    expect(appendMarkdown("- a\n- b\n", "- c")).toEqual({ markdown: "- a\n- b\n- c\n" });
    expect(appendMarkdown("1. a\n", "2. b")).toEqual({ markdown: "1. a\n2. b\n" });
  });

  it("matches headings case-insensitively and with the #s given", () => {
    const out = appendMarkdown(DOC, "More.", "## ideas");
    expect(out).toEqual({ markdown: "# Notes\n\nIntro line.\n\n## Log\n\n- first\n\n## Ideas\n\nSomething.\n\nMore.\n" });
  });

  it("a top-level heading's section runs to the end when nothing outranks it", () => {
    const out = appendMarkdown(DOC, "Tail.", "Notes");
    expect((out as { markdown: string }).markdown.endsWith("Something.\n\nTail.\n")).toBe(true);
  });

  it("reports a missing heading rather than guessing", () => {
    expect(appendMarkdown(DOC, "x", "Nope")).toEqual({ error: "heading_not_found" });
  });

  it("reports an ambiguous heading with the count", () => {
    const doc = "## Log\n\na\n\n## Log\n\nb\n";
    expect(appendMarkdown(doc, "x", "Log")).toEqual({ error: "heading_ambiguous", count: 2 });
  });

  it("ignores headings inside fenced code blocks", () => {
    const doc = "## Real\n\n```\n## Fake\n```\n\ntext\n";
    const out = appendMarkdown(doc, "added", "Fake");
    expect(out).toEqual({ error: "heading_not_found" });
    const ok = appendMarkdown(doc, "added", "Real");
    expect(ok).toEqual({ markdown: "## Real\n\n```\n## Fake\n```\n\ntext\n\nadded\n" });
  });

  it("follows CommonMark fences: same character, a run at least as long, at most 3 spaces of indent", () => {
    const doc = "# Log\n\n````\n```\n# Not a heading\n```\n````\n\n    ```\n# Log2\n";
    expect(appendMarkdown(doc, "- added", "Not a heading")).toEqual({ error: "heading_not_found" });
    // A 4-space-indented run is indented code, so the heading after it is real.
    expect("markdown" in appendMarkdown(doc, "- added", "Log2")).toBe(true);
    expect(appendMarkdown("# Log\n", "````\ncode\n```", "Log")).toEqual({ error: "unbalanced_fence" });
  });

  it("refuses an addition that opens a code fence it never closes", () => {
    // Left alone this is the widest possible breach of what append promises:
    // every heading below the target section becomes the body of the code block,
    // so a two-line append restructures the whole document — and an `auto`
    // append rule would land it with nobody looking.
    const doc = "# Notes\n\n## Log\n\nfirst entry\n\n## Secrets\n\ntop secret\n";
    expect(appendMarkdown(doc, "```\nswallow", "Log")).toEqual({ error: "unbalanced_fence" });
    // A fence the addition closes itself is fine, inside a section or at the end.
    const closed = appendMarkdown(doc, "```\ncode\n```", "Log");
    expect("markdown" in closed).toBe(true);
    if ("markdown" in closed) expect(closed.markdown).toContain("## Secrets");
    expect("markdown" in appendMarkdown(doc, "```\ncode\n```")).toBe(true);
    // A tilde fence cannot be closed by backticks.
    expect(appendMarkdown(doc, "~~~\ncode\n```", "Log")).toEqual({ error: "unbalanced_fence" });
  });
});
