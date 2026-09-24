import { describe, it, expect } from "vitest";
import {
  normalizeImportedMarkdown,
  markdownByteLength,
  MAX_IMPORT_MARKDOWN_BYTES,
  MAX_IMPORT_FILES,
} from "./markdown-import.js";

const imp = (raw: string, filename?: string) => normalizeImportedMarkdown(raw, filename ? { filename } : {});

describe("normalizeImportedMarkdown — input the parser would mangle", () => {
  it("strips a UTF-8 BOM so the first heading survives", () => {
    const r = imp("\uFEFF# Title\n\nbody");
    expect(r.markdown.startsWith("# Title")).toBe(true);
    expect(r.markdown).not.toContain("\uFEFF");
    expect(r.title).toBe("Title");
  });

  it("removes YAML frontmatter instead of parsing it as hr + setext heading", () => {
    const r = imp("---\ntitle: From Matter\ntags: [a, b]\n---\n\n# Real Heading\n\nBody");
    expect(r.markdown).toBe("# Real Heading\n\nBody");
    expect(r.markdown).not.toContain("tags:");
    expect(r.title).toBe("Real Heading");
  });

  it("uses the frontmatter title when the body has no heading of its own", () => {
    const r = imp("---\ntitle: Quarterly Notes\n---\n\nJust prose, no heading.");
    expect(r.title).toBe("Quarterly Notes");
    expect(r.markdown).toBe("# Quarterly Notes\n\nJust prose, no heading.");
  });

  it("normalizes CRLF so no \\r rides into the title", () => {
    const r = imp("# A Title\r\n\r\nbody\r\n");
    expect(r.title).toBe("A Title");
    expect(r.markdown).not.toContain("\r");
  });

  it("strips NUL and other C0 controls that Postgres TEXT would reject", () => {
    const r = imp("# Ti\u0000tle\n\nbo\u0007dy");
    const hasForbiddenControl = [...r.markdown].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f);
    });
    expect(hasForbiddenControl).toBe(false);
    expect(r.title).toBe("Title");
  });
});

describe("normalizeImportedMarkdown — frontmatter detection stays conservative", () => {
  it("leaves a genuine leading thematic break alone", () => {
    const r = imp("---\n\nSome real content here.\n\n---\n\nMore.");
    expect(r.markdown).toContain("Some real content here.");
    expect(r.markdown).toContain("More.");
  });

  it("leaves an unterminated fence alone rather than swallowing the document", () => {
    const r = imp("---\ntitle: Never Closed\n\n# Body Heading\n\ntext");
    expect(r.markdown).toContain("# Body Heading");
    expect(r.markdown).toContain("title: Never Closed");
  });

  it("handles frontmatter containing YAML list continuations", () => {
    const r = imp("---\ntags:\n  - one\n  - two\nauthor: Me\n---\n\n# Kept\n");
    expect(r.markdown).toBe("# Kept");
    expect(r.title).toBe("Kept");
  });

  it("unquotes a quoted frontmatter title", () => {
    expect(imp('---\ntitle: "Quoted: Title"\n---\n\nbody').title).toBe("Quoted: Title");
    expect(imp("---\ntitle: 'Single'\n---\n\nbody").title).toBe("Single");
  });

  it("treats a document that is ONLY frontmatter as empty", () => {
    const r = imp("---\ntitle: Nothing Else\n---\n");
    expect(r.markdown).toBe("");
    expect(r.title).toBe("");
  });
});

describe("normalizeImportedMarkdown — title derivation", () => {
  it("takes an ATX heading at any level, ignoring closing hashes", () => {
    expect(imp("## Section Only\n\nbody").title).toBe("Section Only");
    expect(imp("# Closed Form #\n\nbody").title).toBe("Closed Form");
  });

  it("takes a setext heading", () => {
    const r = imp("Setext Title\n============\n\nbody");
    expect(r.title).toBe("Setext Title");
    expect(r.markdown.startsWith("Setext Title\n===")).toBe(true);
  });

  it("falls back to the filename, cleaned up", () => {
    expect(imp("plain prose", "my_release-notes.md").title).toBe("my release notes");
    expect(imp("plain prose", "/tmp/nested/Deep Notes.markdown").title).toBe("Deep Notes");
  });

  it("falls back to Untitled with neither heading, frontmatter, nor filename", () => {
    const r = imp("just a paragraph");
    expect(r.title).toBe("Untitled");
    expect(r.markdown).toBe("# Untitled\n\njust a paragraph");
  });

  it("prefers an in-body heading over the filename", () => {
    expect(imp("# Real One\n\nbody", "ignored.md").title).toBe("Real One");
  });

  it("clamps a very long title to 200 chars and collapses whitespace", () => {
    const r = imp(`# ${"x".repeat(500)}\n\nbody`);
    expect(r.title).toHaveLength(200);
    expect(imp("#    Spaced     Out   \n\nbody").title).toBe("Spaced Out");
  });

  it("keeps a body that opens with a literal hash as its own paragraph under the prepended heading", () => {
    const r = imp("#hashtag and more", "tags.md");
    expect(r.title).toBe("tags");
    expect(r.markdown).toBe("# tags\n\n#hashtag and more");
  });

  it("is idempotent — re-importing its own output is a no-op", () => {
    const once = imp("plain prose with no heading", "notes.md");
    const twice = imp(once.markdown, "notes.md");
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.title).toBe(once.title);
  });
});

describe("normalizeImportedMarkdown — the title always matches the body's first line", () => {
  const cases = [
    "# Heading Doc\n\nbody",
    "---\ntitle: FM Only\n---\n\nprose",
    "plain prose",
    "\uFEFF# Bom Doc\n\nbody",
    "Setext\n======\n\nbody",
    "## Deeper Heading\n\nbody",
    "---\ntitle: Ignored\n---\n\n# Body Wins\n\nbody",
  ];
  for (const raw of cases) {
    it(`holds for ${JSON.stringify(raw.slice(0, 28))}`, () => {
      const { markdown, title } = imp(raw, "fallback.md");
      const firstLine = markdown.split("\n").find((l) => l.trim() !== "") ?? "";
      const asText = firstLine.replace(/^ {0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
      expect(asText).toBe(title);
    });
  }
});

describe("normalizeImportedMarkdown — empty and whitespace input", () => {
  it("returns empty for empty, whitespace-only, or blank-line input", () => {
    for (const raw of ["", "   ", "\n\n\n", "\r\n\r\n", "\uFEFF"]) {
      expect(imp(raw).markdown).toBe("");
      expect(imp(raw).title).toBe("");
    }
  });

  it("does not invent a title for empty input even with a filename", () => {
    expect(imp("   ", "notes.md")).toEqual({ markdown: "", title: "" });
  });
});

describe("markdownByteLength", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(markdownByteLength("abc")).toBe(3);
    expect(markdownByteLength("文档")).toBe(6);
    expect(markdownByteLength("😀")).toBe(4);
  });

  it("accepts a document far larger than anything hand-written", () => {
    expect(MAX_IMPORT_MARKDOWN_BYTES).toBe(4 * 1024 * 1024);
  });

  it("bounds a batch import to a sane number of documents", () => {
    expect(MAX_IMPORT_FILES).toBe(50);
  });
});

describe("normalizeImportedMarkdown — edge cases", () => {
  it("flattens inline markup in a heading, so the title survives the first flush", () => {
    expect(imp("# The `x` Flag\n\nbody").title).toBe("The x Flag");
    expect(imp("# **Stuga** ships\n\nbody").title).toBe("Stuga ships");
    expect(imp("# A *bold* Title\n\nbody").title).toBe("A bold Title");
    expect(imp("# See [the docs](https://e.com)\n\nbody").title).toBe("See the docs");
    expect(imp("# ~~Old~~ New\n\nbody").title).toBe("Old New");
    expect(imp("# ![logo](l.png) Brand\n\nbody").title).toBe("logo Brand");
  });

  it("does not read a title out of a leading code fence", () => {
    const r = imp("```yaml\n---\napiVersion: v1\n```\n\nApply with kubectl.", "pod.md");
    expect(r.title).toBe("pod");
    expect(r.markdown).toContain("```yaml");
    expect(imp("~~~\ntext\n~~~\n\nbody", "f.md").title).toBe("f");
    expect(imp("    # indented code\n\nbody", "f.md").title).toBe("f");
  });

  it("does not treat a non-paragraph line above --- as a setext heading", () => {
    expect(imp("* item one\n---\n\nprose", "f.md").title).toBe("f");
    expect(imp("1. first\n---\n\nprose", "f.md").title).toBe("f");
    expect(imp("> quoted\n---\n\nprose", "f.md").title).toBe("f");
    expect(imp("| a | b |\n---\n\nprose", "f.md").title).toBe("f");
    // A real paragraph over dashes IS a setext heading.
    expect(imp("Real Setext\n---\n\nprose", "f.md").title).toBe("Real Setext");
  });

  it("strips frontmatter with comments, block scalars, nested maps, quoted keys and empty values", () => {
    const hugo = imp("---\n# Generated by Hugo\ntitle: My Post\ndate: 2026-01-01\n---\n\nReal body.", "my-post.md");
    expect(hugo.title).toBe("My Post");
    expect(hugo.markdown).toBe("# My Post\n\nReal body.");

    for (const fm of [
      "---\ntitle: T\ndescription: |\n  a block\n  scalar\n---\n\nbody",
      "---\ntitle: T\nauthor:\n  name: Me\n  email: m@e.com\n---\n\nbody",
      '---\n"title": T\ndraft: false\n---\n\nbody',
      "---\ntitle: T\nsummary:\n---\n\nbody",
      "---\ntitle: T\ntags: [a, b]\nweight: 3\n---\n\nbody",
    ]) {
      const r = imp(fm, "f.md");
      expect(r.markdown).toBe("# T\n\nbody");
      expect(r.title).toBe("T");
    }
  });

  it("keeps hr-fenced prose that only LOOKS like a one-entry frontmatter block", () => {
    const faq = imp("---\nQ: Why does this exist?\n---\n\nBecause.", "faq.md");
    expect(faq.markdown).toContain("Why does this exist?");
    const todo = imp("---\nTODO: finish the intro\n---\n\n# Real Heading\n\nbody");
    expect(todo.markdown).toContain("TODO: finish the intro");
    expect(imp("---\ntitle: Just A Title\n---\n\nbody").markdown).toBe("# Just A Title\n\nbody");
  });

  it("trims the tail in linear time, whatever the body is made of", () => {
    const pathological = " ".repeat(1024 * 1024) + "x";
    const started = Date.now();
    const out = normalizeImportedMarkdown(pathological);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(normalizeImportedMarkdown("x" + " ".repeat(1024 * 1024)).markdown).toMatch(/x$/);
    expect(out.markdown.endsWith("x")).toBe(true);
  });
});
