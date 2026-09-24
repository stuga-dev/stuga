/**
 * The Markdown import seed: one edit with an empty `old_string` appended to a
 * brand-new document. A new document (with its seeded empty paragraph) must
 * serialize to "", and the imported body must round-trip with its first line
 * equal to the title the node stored, or the next flush renames the document.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { normalizeImportedMarkdown } from "@stuga/protocol/text/markdown-import";
import { yXmlFragmentToMarkdown, applyMarkdownToYXmlFragment, applyCitedStrEdits } from "@stuga/crdt-ops";

/** A fragment in the state the DocActor is in when `/apply-edits` arrives for a new
 *  doc: hydrated from no snapshot, with ensureLoaded()'s seeded empty paragraph. */
function freshDocFragment(): Y.XmlFragment {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment("default");
  frag.insert(0, [new Y.XmlElement("paragraph")]);
  return frag;
}

/** What /apply-edits does with the import's single str_edit. */
function seed(frag: Y.XmlFragment, markdown: string): string {
  const current = yXmlFragmentToMarkdown(frag);
  const next = applyCitedStrEdits(current, [{ old_string: "", new_string: markdown }], []);
  applyMarkdownToYXmlFragment(frag, next, { origin: { agent: "importer" }, originalMarkdown: current });
  return yXmlFragmentToMarkdown(frag);
}

describe("markdown import seeds a brand-new document", () => {
  it("a brand-new doc — with ensureLoaded's seeded paragraph — serializes to empty", () => {
    // The empty-old_string append is only equivalent to "fill the document" while
    // this holds.
    expect(yXmlFragmentToMarkdown(freshDocFragment())).toBe("");
  });

  it("fills the document with the imported markdown", () => {
    const frag = freshDocFragment();
    const { markdown } = normalizeImportedMarkdown("# Release Notes\n\nShipped the thing.", {});
    expect(seed(frag, markdown)).toBe("# Release Notes\n\nShipped the thing.");
  });

  // Explicit budget: this one builds and encodes a >2 MiB CRDT, which sits close
  // enough to vitest's 5s default to time out when the workspace's suites run in
  // parallel. Slow by design, not flaky.
  it("a large table import exceeds one actor storage value, so it MUST snapshot to the blob store", () => {
    // The sizing fact behind PENDING_SNAPSHOT_BYTES in @stuga/doc-actor. Table rows
    // are the worst realistic shape (many tiny blocks, each carrying CRDT identity):
    // the Yjs update runs ~9x the Markdown. A value in the actor's key-value store
    // is one SQLite row, and the actor refuses to journal more than ~2 MiB in one —
    // doing so would fail the durable write AFTER the doc row was created — so it
    // flushes a large seed straight to the blob store instead. If this ratio ever
    // collapses, revisit that threshold rather than assuming markdown size ≈ CRDT size.
    const rows = ["# T", "", "| a | b | c |", "| --- | --- | --- |"];
    for (let i = 0; rows.join("\n").length < 256 * 1024; i++) rows.push(`| cell ${i} | value ${i} | more ${i} |`);
    const markdown = rows.join("\n");

    const doc = new Y.Doc();
    const frag = doc.getXmlFragment("default");
    frag.insert(0, [new Y.XmlElement("paragraph")]);
    seed(frag, markdown);

    const mdBytes = new TextEncoder().encode(markdown).byteLength;
    const crdtBytes = Y.encodeStateAsUpdate(doc).byteLength;
    expect(crdtBytes / mdBytes).toBeGreaterThan(4); // nowhere near 1:1
    expect(crdtBytes).toBeGreaterThan(2 * 1024 * 1024); // over a single storage value
  }, 20_000);

  it("imports a real README — badges and screenshots included — without eating prose", () => {
    // The shape that exposed the worst import bug: an image inside a link inside a
    // paragraph. Because `image` is a BLOCK node in Stuga's schema, the paragraph
    // failed to build and the parser dropped it whole, silently deleting the badge
    // line AND any text sharing its paragraph.
    const readme = [
      "# Stuga",
      "",
      "[![CI](https://img.shields.io/badge/ci-passing-green)](https://ci.example.com)",
      "",
      "Stuga is an AI-native document workspace.",
      "",
      "## Screenshot",
      "",
      "![The editor](docs/editor.png)",
      "",
      "See the docs for more, or read ![the inline diagram](d.png) alongside this text.",
    ].join("\n");
    const { markdown, title } = normalizeImportedMarkdown(readme, { filename: "README.md" });
    const seeded = seed(freshDocFragment(), markdown);
    expect(title).toBe("Stuga");
    expect(seeded).toContain("Stuga is an AI-native document workspace.");
    expect(seeded).toContain("![The editor](docs/editor.png)");
    expect(seeded).toContain("![CI](https://img.shields.io/badge/ci-passing-green)");
    // Text sharing a paragraph with an inline image survives on both sides of it.
    expect(seeded).toContain("See the docs for more, or read");
    expect(seeded).toContain("alongside this text.");
  });

  it("round-trips the structure an imported file actually contains", () => {
    const frag = freshDocFragment();
    const source = [
      "# Design Doc",
      "",
      "Intro with **bold**, *italic*, `code`, and a [link](https://example.com).",
      "",
      "## Table",
      "",
      "| Field | Type |",
      "| --- | --- |",
      "| id | string |",
      "",
      "## List",
      "",
      "* one",
      "",
      "  * nested",
      "",
      "> quoted",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const { markdown } = normalizeImportedMarkdown(source, {});
    const seeded = seed(frag, markdown);
    expect(seeded).toContain("# Design Doc");
    expect(seeded).toContain("| Field | Type |");
    expect(seeded).toContain("* nested");
    expect(seeded).toContain("> quoted");
    expect(seeded).toContain("const x = 1;");
    // Re-seeding the serialized output is a fixed point — no drift on re-import.
    expect(seed(freshDocFragment(), seeded)).toBe(seeded);
  });

  // NOTE: "title equals the seeded doc's first line" is covered authoritatively in
  // packages/doc-actor/src/text-extract.test.ts (real extractText/deriveTitle over the
  // seeded CRDT, 17 cases) and at the markdown level by the property block in
  // packages/protocol/src/text/markdown-import.test.ts — no third copy here.

  it("preserves a leading heading that a BOM would otherwise have escaped", () => {
    // Without the normalizer this seeds the literal text "\# Title" — the
    // document's own H1 turned into a paragraph.
    const raw = "﻿# Title\n\nbody";
    expect(seed(freshDocFragment(), raw)).toContain("\\#");

    const { markdown } = normalizeImportedMarkdown(raw, {});
    const seeded = seed(freshDocFragment(), markdown);
    expect(seeded.startsWith("# Title")).toBe(true);
    expect(seeded).not.toContain("\\#");
  });

  it("drops frontmatter that would otherwise seed an hr plus a bogus heading", () => {
    const raw = "---\ntitle: Meta\ntags: [a]\n---\n\n# Real\n\nBody";
    // The unnormalized shape: a thematic break, then "title: Meta tags: [a]"
    // parsed as a setext H2.
    const rawSeeded = seed(freshDocFragment(), raw);
    expect(rawSeeded).toContain("tags:");

    const { markdown } = normalizeImportedMarkdown(raw, {});
    const seeded = seed(freshDocFragment(), markdown);
    expect(seeded).toBe("# Real\n\nBody");
  });
});
