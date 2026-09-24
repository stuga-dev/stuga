import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Image } from "@tiptap/extension-image";
import type { Node as PMNode } from "prosemirror-model";
import {
  applyMarkdownToYXmlFragment,
  yXmlFragmentToMarkdown,
  getStugaSchema,
  markdownToDoc,
  docToMarkdown,
  wordDiff,
  topBlocks,
  previewBlockSegments,
  blockDiffMarkdown,
  resolveSegment,
} from "./index.js";
import { blockDiffSegments, isDescendableContainer, type BlockDiffSegment } from "./diff/blocks.js";
import { applyStrEdits } from "./diff/str-edits.js";
import { normalizeMarkdownTables } from "./markdown/tables.js";
import { FootnoteReference, FootnoteDefinition } from "./footnote-nodes.js";
import { Mention } from "./mention-node.js";

function freshFrag(): Y.XmlFragment {
  return new Y.Doc().getXmlFragment("default");
}
function nodeNames(frag: Y.XmlFragment): string[] {
  return frag.toArray().map((n) => (n instanceof Y.XmlElement ? n.nodeName : "#text"));
}

describe("markdown ↔ schema", () => {
  it("parses every StarterKit block/mark into proper nodes (not a flat paragraph)", () => {
    const md = [
      "# Heading one",
      "",
      "A paragraph with **bold**, *italic*, `code`, and ~~strike~~.",
      "",
      "- first",
      "- second",
      "",
      "> a quote",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");
    const doc = markdownToDoc(md, getStugaSchema());
    const names = [] as string[];
    doc.content.forEach((c) => names.push(c.type.name));
    expect(names).toEqual(["heading", "paragraph", "bulletList", "blockquote", "codeBlock"]);
    expect(doc.firstChild!.attrs.level).toBe(1);
  });

  it("round-trips Markdown through Y and back, preserving structure", () => {
    const md = "## Title\n\nHello **world** and `code`.\n\n1. one\n2. two";
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, md);
    expect(nodeNames(frag)).toEqual(["heading", "paragraph", "orderedList"]);
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("## Title");
    expect(out).toContain("**world**");
    expect(out).toContain("`code`");
    expect(out).toContain("1. one");
    // idempotent: re-applying the serialized form yields the same structure
    const frag2 = freshFrag();
    applyMarkdownToYXmlFragment(frag2, out);
    expect(nodeNames(frag2)).toEqual(nodeNames(frag));
  });
});

describe("AI-citation footnotes (round-trip losslessly, not empty-serialized)", () => {
  const FN = [
    "Earth's mass is 5.97e24 kg [^1] and it orbits the Sun [^2].",
    "",
    "## Sources",
    "",
    '[^1]: [Earth facts — Mass](/doc/abc) "Earth mass is 5.97e24 kg."',
    "[^2]: Plain text definition.",
  ].join("\n");

  it("parses [^n] refs as inline atoms and [^n]: defs as block nodes", () => {
    const doc = markdownToDoc(FN, getStugaSchema());
    const refs: number[] = [];
    const defs: number[] = [];
    doc.descendants((n) => {
      if (n.type.name === "footnoteReference") refs.push(n.attrs.n);
      if (n.type.name === "footnoteDefinition") defs.push(n.attrs.n);
    });
    expect(refs).toEqual([1, 2]);
    expect(defs).toEqual([1, 2]);
  });

  it("serializes footnotes back to real markdown — link + excerpt preserved", () => {
    const doc = markdownToDoc(FN, getStugaSchema());
    const out = docToMarkdown(doc);
    // The inline markers survive (NOT empty — the whole point is traceability).
    expect(out).toContain("kg [^1] and");
    expect(out).toContain("Sun [^2].");
    // The definition carries the source link + the frozen excerpt.
    expect(out).toContain("[^1]: [Earth facts — Mass](/doc/abc)");
    expect(out).toContain("Earth mass is 5.97e24 kg.");
    expect(out).toContain("[^2]: Plain text definition.");
  });

  it("round-trips losslessly through the full CRDT bridge", () => {
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, FN);
    expect(nodeNames(frag)).toEqual([
      "paragraph",
      "heading",
      "footnoteDefinition",
      "footnoteDefinition",
    ]);
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("[^1]");
    expect(out).toContain("[^1]: [Earth facts — Mass](/doc/abc)");
    // idempotent
    const frag2 = freshFrag();
    applyMarkdownToYXmlFragment(frag2, out);
    expect(nodeNames(frag2)).toEqual(nodeNames(frag));
  });

  it("keeps a footnote ref in an UNEDITED block through a 3-way merge", () => {
    // The AI edits a different block; the cited paragraph (with [^1]) must keep
    // its footnote ref rather than being dropped by the merge/re-parse.
    const original = FN;
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, original);
    // AI proposes changing only the Sources heading text (unrelated to [^1]).
    const proposed = original.replace("## Sources", "## References");
    applyMarkdownToYXmlFragment(frag, proposed, { originalMarkdown: original });
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("[^1] and it orbits");
    expect(out).toContain("[^1]: [Earth facts — Mass](/doc/abc)");
    expect(out).toContain("## References");
  });

  it("keeps a [^n] footnote reference INSIDE a table cell through the round-trip", () => {
    // A footnote reference has no textContent, so the table serializer must walk inline content.
    const md = [
      "| Term | Meaning |",
      "| --- | --- |",
      "| F&B | Forecast and Build [^2] |",
      "| Build | Lifecycle [^5] |",
      "",
      "## Sources",
      "",
      '[^2]: [Handbook — F&B](/doc/handbook) "Forecast and Build."',
      '[^5]: [Handbook — Build](/doc/handbook) "Software Development Lifecycle."',
    ].join("\n");
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, md);
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("Forecast and Build [^2] |");
    expect(out).toContain("Lifecycle [^5] |");
    expect(out).toContain("[^2]: [Handbook — F&B](/doc/handbook)");
    // idempotent — the markers survive a second round-trip too.
    const frag2 = freshFrag();
    applyMarkdownToYXmlFragment(frag2, out);
    expect(yXmlFragmentToMarkdown(frag2)).toContain("[^2] |");
  });

  /**
   * Orphans are kept. An orphan definition (its sentence deleted) and an orphan
   * reference (its definition deleted) are both reachable, and the live document
   * keeps a node for each; the projection must parse them back or the merge sees
   * a phantom edit. Accepted cost: imported literal text like `[^1]` parses as a
   * citation; our own output escapes `[`, so it never does.
   */
  it("a definition with no matching reference is KEPT (round-trip invariant)", () => {
    const md = "Body with no refs.\n\n[^1]: orphan definition";
    const doc = markdownToDoc(md, getStugaSchema());
    const defs: number[] = [];
    doc.descendants((n) => {
      if (n.type.name === "footnoteDefinition") defs.push(n.attrs.n);
    });
    expect(defs).toEqual([1]);
    // parse(serialize(doc)) === doc, and serialization is a fixed point.
    const out = docToMarkdown(doc);
    expect(out).toContain("[^1]: orphan definition");
    expect(markdownToDoc(out, getStugaSchema()).toJSON()).toEqual(doc.toJSON());
    expect(docToMarkdown(markdownToDoc(out, getStugaSchema()))).toBe(out);
  });

  it("a reference with no matching definition stays a footnoteReference (round-trip invariant)", () => {
    const md = "Body with a ref [^1] but no def.";
    const doc = markdownToDoc(md, getStugaSchema());
    const refs: number[] = [];
    doc.descendants((n) => {
      if (n.type.name === "footnoteReference") refs.push(n.attrs.n);
    });
    expect(refs).toEqual([1]);
    const out = docToMarkdown(doc);
    expect(out).toContain("ref [^1] but");
    expect(markdownToDoc(out, getStugaSchema()).toJSON()).toEqual(doc.toJSON());
    expect(docToMarkdown(markdownToDoc(out, getStugaSchema()))).toBe(out);
  });

  it("a definition written ABOVE its reference stays where the author put it", () => {
    // Moving definitions to the end would change block order between live and projection.
    const md = "[^1]: defined first\n\nProse citing it [^1].";
    const doc = markdownToDoc(md, getStugaSchema());
    const names: string[] = [];
    doc.content.forEach((c) => names.push(c.type.name));
    expect(names).toEqual(["footnoteDefinition", "paragraph"]);
    const out = docToMarkdown(doc);
    expect(markdownToDoc(out, getStugaSchema()).toJSON()).toEqual(doc.toJSON());
  });

  it("a literal `[^1]` typed as text does NOT become a citation on the way back", () => {
    // A text node reading "[^1]" serializes escaped, so our output never becomes a marker.
    const schema = getStugaSchema();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("the class [^1] matches")]),
    ]);
    const out = docToMarkdown(doc);
    expect(out).toContain("\\[");
    const back = markdownToDoc(out, schema);
    let hasRef = false;
    back.descendants((n) => {
      if (n.type.name === "footnoteReference") hasRef = true;
    });
    expect(hasRef).toBe(false);
    expect(back.toJSON()).toEqual(doc.toJSON());
  });

  it("`^[inline note]` stays literal text (no ProseMirror node exists for it)", () => {
    // An inline note has no node, so its characters stay literal text and round-trip.
    const schema = getStugaSchema();
    const doc = markdownToDoc("Body with ^[an inline note] in it.", schema);
    expect(doc.textContent).toContain("^[an inline note]");
    const out = docToMarkdown(doc);
    expect(markdownToDoc(out, schema).toJSON()).toEqual(doc.toJSON());
  });
});

describe("mermaid code block (client NodeView, server schema unchanged)", () => {
  // The live editor swaps StarterKit's bundled codeBlock for MermaidCodeBlock
  // (CodeBlock.extend + addNodeView) and appends it AFTER StarterKit, so its
  // node registers LAST — while the server schema (stugaExtensions) keeps
  // StarterKit's codeBlock in its natural 4th position. These assert that the
  // ```mermaid path is byte-identical across that ordering difference, so the
  // node never needs to know mermaid exists.

  it("round-trips a ```mermaid fence as codeBlock{language:'mermaid'} through Y", () => {
    const md = ["# Diagram", "", "```mermaid", "graph TD; A-->B;", "```"].join("\n");
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, md);
    expect(nodeNames(frag)).toEqual(["heading", "codeBlock"]);
    const cb = frag.toArray()[1] as Y.XmlElement;
    expect(cb.getAttribute("language")).toBe("mermaid");
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("```mermaid");
    expect(out).toContain("graph TD; A-->B;");
    // Idempotent: re-applying the serialized form yields the same structure.
    const frag2 = freshFrag();
    applyMarkdownToYXmlFragment(frag2, out);
    expect(nodeNames(frag2)).toEqual(nodeNames(frag));
    expect((frag2.toArray()[1] as Y.XmlElement).getAttribute("language")).toBe("mermaid");
  });

  it("editor schema (codeBlock registered LAST) is Y-compatible with the server schema", async () => {
    // Build the editor's schema exactly as apps/web does: StarterKit with
    // codeBlock:false, then a CodeBlock.extend appended after it.
    const CodeBlock = (await import("@tiptap/extension-code-block")).default;
    // `addNodeView` is a VIEW field, not a schema one — `getSchema()` never
    // reads it — so what it returns is irrelevant here. What is being
    // reproduced is the SHAPE of the editor's extension list: a `.extend()`ed
    // CodeBlock mounted after a `codeBlock:false` StarterKit. `null` is the
    // typed spelling of "no custom view" (apps/web returns a real factory).
    const MermaidCodeBlock = CodeBlock.extend({ addNodeView: () => null });
    const editorSchema = getSchema([
      StarterKit.configure({ undoRedo: false, codeBlock: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: false }),
      MermaidCodeBlock,
      FootnoteReference,
      FootnoteDefinition,
      Mention,
    ]);
    const serverSchema = getStugaSchema();

    // The codeBlock NODE SPEC must be identical (attrs/content/code/defining),
    // even though its registration index differs.
    const specOf = (s: typeof editorSchema) => {
      const cb = s.nodes.codeBlock!.spec;
      return JSON.stringify({ content: cb.content, group: cb.group, code: cb.code, defining: cb.defining, attrs: cb.attrs });
    };
    expect(specOf(editorSchema)).toBe(specOf(serverSchema));

    // A mermaid doc authored under the EDITOR schema must read back byte-for-byte
    // under the SERVER schema through the real Y round-trip — this is the exact
    // client-writes / node-reads path.
    const md = "```mermaid\nsequenceDiagram\n  A->>B: hi\n```";
    const editorDoc = markdownToDoc(md, editorSchema);
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment("default");
    prosemirrorToYXmlFragment(editorDoc, frag);
    const readBack: PMNode = yXmlFragmentToProseMirrorRootNode(frag, serverSchema);
    expect(readBack.firstChild!.type.name).toBe("codeBlock");
    expect(readBack.firstChild!.attrs.language).toBe("mermaid");
    expect(readBack.firstChild!.textContent).toContain("sequenceDiagram");
    // And the server can serialize it back to the same fence.
    expect(docToMarkdown(readBack)).toContain("```mermaid");
  });
});

describe("minimal diff (structure-preserving)", () => {
  it("touches ONLY the changed block; ALL block instances survive (intra-block text diff)", () => {
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, "para one\n\npara two\n\npara three");
    const before = frag.toArray();
    expect(before.length).toBe(3);

    // Change only the middle paragraph (full-doc target, no original).
    applyMarkdownToYXmlFragment(frag, "para one\n\npara TWO changed\n\npara three");
    const after = frag.toArray();

    expect(after.length).toBe(3);
    // updateYFragment diffs minimally: unchanged blocks AND the edited block keep
    // their CRDT identity — only the changed characters inside it are rewritten.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect((after[1] as Y.XmlElement).toString()).toContain("para TWO changed");
    expect((after[0] as Y.XmlElement).toString()).toContain("para one");
  });

  it("does not destroy headings/lists when only prose changes", () => {
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, "# Doc\n\nintro\n\n- a\n- b");
    const heading = frag.toArray()[0];
    applyMarkdownToYXmlFragment(frag, "# Doc\n\nintro REWRITTEN\n\n- a\n- b");
    expect(nodeNames(frag)).toEqual(["heading", "paragraph", "bulletList"]);
    expect(frag.toArray()[0]).toBe(heading); // heading untouched
  });
});

describe("3-way merge (concurrent edits preserved)", () => {
  it("keeps a concurrent edit outside the AI's change-range", () => {
    const original = "Alpha\n\nBeta\n\nGamma";
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, original);

    // A human concurrently edits the FIRST block while the AI is "thinking".
    applyMarkdownToYXmlFragment(frag, "Alpha edited by human\n\nBeta\n\nGamma");

    // The AI (which saw `original`) proposes changing only the SECOND block.
    applyMarkdownToYXmlFragment(frag, "Alpha\n\nBeta by AI\n\nGamma", { originalMarkdown: original });

    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("Alpha edited by human"); // concurrent edit survived
    expect(out).toContain("Beta by AI"); // AI change applied
    expect(out).not.toContain("\nBeta\n"); // old Beta gone
    expect(nodeNames(frag)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("keeps blocks a collaborator APPENDED past the original's end", () => {
    const original = "Alpha\n\nBeta\n\nGamma";
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, original);
    // Collaborator appends two new blocks at the end during the AI turn.
    applyMarkdownToYXmlFragment(frag, "Alpha\n\nBeta\n\nGamma\n\nDelta\n\nEcho");
    // AI (saw `original`) changes only the middle block.
    applyMarkdownToYXmlFragment(frag, "Alpha\n\nBeta by AI\n\nGamma", { originalMarkdown: original });
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("Beta by AI");
    expect(out).toContain("Gamma"); // not dropped
    expect(out).toContain("Delta"); // concurrent append survived
    expect(out).toContain("Echo"); //  "
    expect(nodeNames(frag).length).toBe(5);
  });

  it("does not drop the AI's suffix block when the doc shrank concurrently", () => {
    const original = "A\n\nX\n\nB";
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, original);
    applyMarkdownToYXmlFragment(frag, "A"); // collaborator deleted X and B
    // AI proposes A, Z, B (changed middle). Overlaps the deletion ⇒ AI proposal wins.
    applyMarkdownToYXmlFragment(frag, "A\n\nZ\n\nB", { originalMarkdown: original });
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("Z");
    expect(out).toContain("B"); // AI-emitted block not silently lost
  });

  it("without originalMarkdown, a full-doc proposal overwrites (documents the trade-off)", () => {
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, "Alpha\n\nBeta\n\nGamma");
    applyMarkdownToYXmlFragment(frag, "Alpha edited by human\n\nBeta\n\nGamma");
    // No original ⇒ target is the AI's full doc, which lacks the human edit.
    applyMarkdownToYXmlFragment(frag, "Alpha\n\nBeta by AI\n\nGamma");
    expect(yXmlFragmentToMarkdown(frag)).not.toContain("edited by human");
  });
});

describe("transaction origin", () => {
  it("tags the applying transaction with the given origin", () => {
    const ydoc = new Y.Doc();
    const frag = ydoc.getXmlFragment("default");
    let seenOrigin: unknown = undefined;
    ydoc.on("afterTransaction", (tr) => {
      if (tr.changed.size) seenOrigin = tr.origin;
    });
    applyMarkdownToYXmlFragment(frag, "hello", { origin: "ai-accept" });
    expect(seenOrigin).toBe("ai-accept");
  });
});

describe("images and links", () => {
  it("serializes an editor-inserted image as ![alt](src)", () => {
    const schema = getStugaSchema();
    // Build the doc the way the editor does (setImage → a block image node),
    // then write it into a fragment and serialize back.
    const img = schema.nodes.image!.create({ src: "diagram.png", alt: "the diagram" });
    const para = schema.nodes.paragraph!.create(null, schema.text("See "));
    const doc = schema.topNodeType.create(null, [img, para]);
    const out = docToMarkdown(doc);
    expect(out).toContain("the diagram"); // alt kept
    expect(out).toContain("diagram.png"); // src round-trips
  });

  // The image `title` attr is the CAPTION slot: the editor's ImageCaption
  // decoration renders it, and it is the ONLY reason a caption needs no schema
  // or serializer change. Nothing else pins it, so if the serializer ever stops
  // emitting the quoted title, captions silently vanish on the next round trip.
  it("round-trips an image caption through the markdown title slot", () => {
    const schema = getStugaSchema();
    const img = schema.nodes.image!.create({ src: "chart.png", alt: "Bar chart", title: "Fig 1 — Q3 revenue" });
    const doc = schema.topNodeType.create(null, [img]);
    expect(docToMarkdown(doc)).toContain('![Bar chart](chart.png "Fig 1 — Q3 revenue")');

    // …and back: the caption must survive Markdown → CRDT → Markdown, or an AI
    // edit that rewrites the block would quietly drop it.
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, '![Bar chart](chart.png "Fig 1 — Q3 revenue")');
    expect(yXmlFragmentToMarkdown(frag)).toContain('"Fig 1 — Q3 revenue"');
  });

  // An image with NO caption must not grow an empty title — the clear path in
  // ImageCaptionBubble writes null for exactly this reason.
  it("emits a bare ![alt](src) when there is no caption", () => {
    const schema = getStugaSchema();
    const img = schema.nodes.image!.create({ src: "chart.png", alt: "Bar chart", title: null });
    const doc = schema.topNodeType.create(null, [img]);
    expect(docToMarkdown(doc).trim()).toBe("![Bar chart](chart.png)");
  });

  // The editor writes real `link` marks, so the bridge must round-trip them.
  it("round-trips a link mark as [text](href) through Markdown↔CRDT", () => {
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, "See [the docs](https://x.dev) now.");
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("[the docs](https://x.dev)"); // url preserved, not dropped
  });

  // GFM has no underline syntax: the mark degrades to plain text and never throws.
  it("degrades an underline mark to plain text without throwing", () => {
    const schema = getStugaSchema();
    const u = schema.marks.underline!.create();
    const para = schema.nodes.paragraph!.create(null, schema.text("underlined", [u]));
    const doc = schema.topNodeType.create(null, [para]);
    expect(() => docToMarkdown(doc)).not.toThrow();
    expect(docToMarkdown(doc).trim()).toBe("underlined");
  });
});

describe("tables round-trip", () => {
  it("preserves a GFM table through Markdown↔CRDT", () => {
    const frag = freshFrag();
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    applyMarkdownToYXmlFragment(frag, md);
    expect(nodeNames(frag)).toContain("table");
    const out = yXmlFragmentToMarkdown(frag);
    // header + body cells survive
    for (const cell of ["A", "B", "1", "2", "3", "4"]) expect(out).toContain(cell);
    expect(out).toContain("---"); // separator row present
  });

  // AI-authored tables strict GFM would reject into a paragraph of pipes still parse as tables.
  const hasTable = (md: string): boolean => {
    let found = false;
    markdownToDoc(md, getStugaSchema()).descendants((n) => {
      if (n.type.name === "table") found = true;
      return true;
    });
    return found;
  };

  it("repairs a delimiter row whose column count != the header (fewer)", () => {
    expect(hasTable("t\n\n| a | b | c | d | e |\n| --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |")).toBe(true);
  });

  it("repairs a delimiter row whose column count != the header (more)", () => {
    expect(hasTable("t\n\n| a | b | c |\n|---|---|---|---|---|\n| 1 | 2 | 3 |")).toBe(true);
  });

  it("repairs a table indented 4 spaces (would parse as a code block)", () => {
    expect(hasTable("t\n\n    | a | b |\n    |---|---|\n    | 1 | 2 |")).toBe(true);
  });

  it("preserves per-column alignment when repairing", () => {
    const out = normalizeMarkdownTables("t\n\n| a | b | c | d |\n|:--|:-:|\n| 1 | 2 | 3 | 4 |");
    // Rebuilt delimiter keeps the given alignments and pads the rest to 4 cols.
    expect(out).toContain("| :-- | :-: | --- | --- |");
  });

  it("does NOT touch pipes in ordinary prose", () => {
    const md = "use the | pipe | char in a sentence, not a table";
    expect(normalizeMarkdownTables(md)).toBe(md);
    expect(hasTable(md)).toBe(false);
  });

  it("does NOT touch pipes inside a fenced code block", () => {
    const md = "```\n| a | b |\n|---|\n```";
    expect(normalizeMarkdownTables(md)).toBe(md);
  });

  it("keeps a fence open across a different fence character or a shorter run", () => {
    const tilde = "```\n~~~\n| a | b |\n|---|\n```";
    expect(normalizeMarkdownTables(tilde)).toBe(tilde);
    const shorter = "````\n```\n| a | b |\n|---|\n````";
    expect(normalizeMarkdownTables(shorter)).toBe(shorter);
    const withInfo = "```md\n```js\n| a | b |\n|---|\n```";
    expect(normalizeMarkdownTables(withInfo)).toBe(withInfo);
  });

  it("does not take a 4-space-indented run of backticks for a fence", () => {
    // Indented code, not a fence: the table after it is still repaired.
    const out = normalizeMarkdownTables("    ```\n\n| a | b | c |\n|---|\n| 1 | 2 | 3 |");
    expect(out).toContain("| --- | --- | --- |");
  });

  it("recognises a fence nested in a list item by its indent past the item", () => {
    const md = "- item\n\n    - nested\n\n      ```\n      | a | b |\n      |---|\n      ```";
    expect(normalizeMarkdownTables(md)).toBe(md);
  });
});

// Resize attrs (colwidth, width, height) have no markdown spelling but must survive the CRDT round trip.
describe("resize dimensions survive the CRDT round-trip", () => {
  it("keeps image width/height attrs through Y.XmlFragment", () => {
    const schema = getStugaSchema();
    const img = schema.nodes.image!.create({ src: "diagram.png", alt: "d", width: 320, height: 200 });
    const doc = schema.topNodeType.create(null, [img, schema.nodes.paragraph!.create()]);

    const frag = freshFrag();
    prosemirrorToYXmlFragment(doc, frag);
    const back = yXmlFragmentToProseMirrorRootNode(frag, schema) as PMNode;

    expect(back.firstChild!.type.name).toBe("image");
    expect(back.firstChild!.attrs.width).toBe(320);
    expect(back.firstChild!.attrs.height).toBe(200);
  });

  it("keeps per-cell colwidth through Y.XmlFragment", () => {
    const schema = getStugaSchema();
    const cell = (w: number[] | null, txt: string) =>
      schema.nodes.tableCell!.create({ colwidth: w }, schema.nodes.paragraph!.create(null, schema.text(txt)));
    const row = schema.nodes.tableRow!.create(null, [cell([180], "A"), cell([90], "B")]);
    const table = schema.nodes.table!.create(null, [row]);
    const doc = schema.topNodeType.create(null, [table]);

    const frag = freshFrag();
    prosemirrorToYXmlFragment(doc, frag);
    const back = yXmlFragmentToProseMirrorRootNode(frag, schema) as PMNode;

    const widths: (number[] | null)[] = [];
    back.descendants((n) => {
      if (n.type.name === "tableCell") widths.push(n.attrs.colwidth);
    });
    expect(widths).toEqual([[180], [90]]);
  });

  it("getSchema is byte-identical whether resize is enabled or not (CRDT-safe to flip)", () => {
    // Editor.tsx turns resize ON; schema.ts leaves it OFF. That divergence is
    // only safe because neither changes the node/mark/attr set. Pin it here.
    const sig = (exts: Parameters<typeof getSchema>[0]) => {
      const s = getSchema(exts);
      const nodes = Object.entries(s.nodes)
        .map(([n, t]) => `${n}:${Object.keys(t.spec.attrs || {}).sort().join(",")}`)
        .sort();
      return JSON.stringify({ nodes, marks: Object.keys(s.marks).sort() });
    };
    const off = sig([StarterKit.configure({ undoRedo: false }), Table.configure({ resizable: false }), TableRow, TableHeader, TableCell, Image.configure({ inline: false }), FootnoteReference, FootnoteDefinition]);
    const on = sig([StarterKit.configure({ undoRedo: false }), Table.configure({ resizable: true }), TableRow, TableHeader, TableCell, Image.configure({ inline: false, resize: { enabled: true } }), FootnoteReference, FootnoteDefinition]);
    expect(on).toBe(off);
  });

  it("the server schema includes the footnote nodes (byte-identical with the editor's)", () => {
    const s = getStugaSchema();
    expect(s.nodes.footnoteReference).toBeTruthy();
    expect(s.nodes.footnoteDefinition).toBeTruthy();
    // The reference is an inline atom; the definition is a block with inline content.
    expect(s.nodes.footnoteReference!.spec.inline).toBe(true);
    expect(s.nodes.footnoteReference!.spec.atom).toBe(true);
    expect(s.nodes.footnoteDefinition!.spec.content).toBe("inline*");
    // Both carry only the `n` attr, so editor + server schemas agree.
    expect(Object.keys(s.nodes.footnoteReference!.spec.attrs || {})).toEqual(["n"]);
    expect(Object.keys(s.nodes.footnoteDefinition!.spec.attrs || {})).toEqual(["n"]);
  });
});

describe("preview block diff (preview == accept-result)", () => {
  // The contract the inline preview relies on: splicing `replacement` into the
  // CURRENT doc's top-level blocks at [startBlock, endBlock) yields exactly what
  // applyMarkdownToYXmlFragment commits — so the previewed change is byte-identical
  // to what Accept does. We assert that for every mergeTarget branch.
  const schema = getStugaSchema();
  const parse = (md: string) => markdownToDoc(md, schema);
  /** The one top-level change `previewBlockSegments` reports for these fixtures. */
  function onlySegment(current: ReturnType<typeof parse>, proposed: string, original: string): BlockDiffSegment {
    const segs = previewBlockSegments(current, proposed, original);
    expect(segs.length).toBeLessThanOrEqual(1);
    const seg = segs[0] ?? { startBlock: 0, endBlock: 0, replacement: [], path: [] };
    expect(seg.path).toEqual([]);
    return seg;
  }
  const md = (nodes: ReturnType<typeof parse>[]) => docToMarkdown(schema.topNodeType.create(null, nodes));
  function splicedMarkdown(current: ReturnType<typeof parse>, p: BlockDiffSegment): string {
    const cur = topBlocks(current);
    const merged = [...cur.slice(0, p.startBlock), ...p.replacement, ...cur.slice(p.endBlock)];
    // Build a doc out of the spliced blocks and serialize, matching how the CRDT
    // fragment serializes after the accept path writes the same `target`.
    return yXmlFragmentToMarkdown(buildFrag(merged.map((n) => docToMarkdown(schema.topNodeType.create(null, [n]))).join("\n\n")));
  }
  function buildFrag(md: string): Y.XmlFragment {
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, md);
    return frag;
  }

  it("no concurrent edit: preview region equals the accept result", () => {
    const original = "Alpha\n\nBeta\n\nGamma";
    const proposed = "Alpha\n\nBeta by AI\n\nGamma";
    const p = onlySegment(parse(original), proposed, original);
    expect(p.startBlock).toBe(1);
    expect(p.endBlock).toBe(2);
    expect(md(p.replacement)).toContain("Beta by AI");

    const frag = buildFrag(original);
    applyMarkdownToYXmlFragment(frag, proposed, { originalMarkdown: original });
    expect(splicedMarkdown(parse(original), p)).toBe(yXmlFragmentToMarkdown(frag));
  });

  it("concurrent edit OUTSIDE the AI range: preview reflects the 3-way merge", () => {
    const original = "Alpha\n\nBeta\n\nGamma";
    const current = "Alpha edited by human\n\nBeta\n\nGamma"; // collaborator changed block 0
    const proposed = "Alpha\n\nBeta by AI\n\nGamma"; // AI (saw original) changed block 1
    const p = onlySegment(parse(current), proposed, original);
    // Net change vs CURRENT is only block 1 (block 0's human edit is already live).
    expect(p.startBlock).toBe(1);
    expect(p.endBlock).toBe(2);
    expect(md(p.replacement)).toContain("Beta by AI");

    const frag = buildFrag(current);
    applyMarkdownToYXmlFragment(frag, proposed, { originalMarkdown: original });
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("Alpha edited by human");
    expect(splicedMarkdown(parse(current), p)).toBe(out);
  });

  it("overlapping edits: preview covers the full proposal (AI wins)", () => {
    const original = "A\n\nX\n\nB";
    const current = "A"; // collaborator deleted X and B
    const proposed = "A\n\nZ\n\nB"; // overlaps the deletion ⇒ mergeTarget returns full proposal
    const p = onlySegment(parse(current), proposed, original);
    const frag = buildFrag(current);
    applyMarkdownToYXmlFragment(frag, proposed, { originalMarkdown: original });
    expect(splicedMarkdown(parse(current), p)).toBe(yXmlFragmentToMarkdown(frag));
  });

  it("pure insertion: start == end with non-empty replacement", () => {
    const current = "one\n\ntwo";
    const proposed = "one\n\ninserted\n\ntwo";
    const p = onlySegment(parse(current), proposed, current);
    expect(p.startBlock).toBe(p.endBlock); // nothing removed
    expect(p.replacement.length).toBe(1);
    expect(md(p.replacement)).toContain("inserted");
  });

  it("pure deletion: non-empty range with empty replacement", () => {
    const current = "one\n\ndelete me\n\nthree";
    const proposed = "one\n\nthree";
    const p = onlySegment(parse(current), proposed, current);
    expect(p.endBlock).toBeGreaterThan(p.startBlock); // a block removed
    expect(p.replacement.length).toBe(0);
  });

  it("no-op: identical docs produce an empty diff", () => {
    const md = "alpha\n\nbeta";
    const p = onlySegment(parse(md), md, md);
    expect(p.startBlock).toBe(p.endBlock);
    expect(p.replacement.length).toBe(0);
  });

  it("block indices address `current` directly — they index the passed node, not a re-parse", () => {
    // Indices address the passed live doc, including an empty paragraph a re-parse would drop.
    const current = schema.topNodeType.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("one")),
      schema.nodes.paragraph!.create(), // empty — markdownToDoc would never produce this from a round-trip
      schema.nodes.paragraph!.create(null, schema.text("three")),
    ]);
    expect(current.childCount).toBe(3);
    // AI rewrites the THIRD block. Indices must point at child index 2, not 1.
    const p = onlySegment(current, "one\n\nthree CHANGED", "one\n\nthree");
    expect(p.startBlock).toBe(2);
    expect(p.endBlock).toBe(3);
    expect(current.child(p.startBlock).textContent).toBe("three"); // the block being replaced
    expect(md(p.replacement)).toContain("three CHANGED");
  });
});

describe("phantom-diff: empty paragraphs + concurrent edits survive an AI edit", () => {
  // Baseline and proposal are projections without empty paragraphs, so the merge
  // runs in projection space and maps back: empty paragraphs and a collaborator's
  // concurrent edit both survive.
  /** Build a live fragment with the given blocks; "" means an empty paragraph
   *  (a projection-invisible slot that no markdown round-trip would reproduce). */
  function liveFrag(blocks: string[]): Y.XmlFragment {
    const frag = freshFrag();
    const doc = frag.doc!;
    doc.transact(() => {
      const els = blocks.map((txt) => {
        const el = new Y.XmlElement("paragraph");
        if (txt) el.insert(0, [new Y.XmlText(txt)]);
        return el;
      });
      frag.insert(0, els);
    });
    return frag;
  }

  it("preserves empty paragraphs between untouched blocks when the AI edits one block", () => {
    const frag = liveFrag(["Alpha", "", "Beta", "", "Gamma"]);
    expect(frag.length).toBe(5);
    const baseline = yXmlFragmentToMarkdown(frag); // "Alpha\n\nBeta\n\nGamma" (empties dropped)
    const proposed = baseline.replace("Beta", "Beta by AI");

    applyMarkdownToYXmlFragment(frag, proposed, { originalMarkdown: baseline });

    // All five live blocks survive: the two empty paragraphs are NOT stripped.
    expect(frag.length).toBe(5);
    expect(nodeNames(frag)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph", "paragraph"]);
    const texts = frag.toArray().map((n) => (n as Y.XmlElement).toString());
    expect(texts[0]).toContain("Alpha");
    expect(texts[2]).toContain("Beta by AI");
    expect(texts[4]).toContain("Gamma");
    // The 1st and 3rd blocks are still empty.
    expect((frag.get(1) as Y.XmlElement).length).toBe(0);
    expect((frag.get(3) as Y.XmlElement).length).toBe(0);
  });

  it("does NOT clobber a concurrent human edit outside the AI's changed block", () => {
    const frag = liveFrag(["Alpha", "", "Beta", "", "Gamma"]);
    const baseline = yXmlFragmentToMarkdown(frag); // what the AI was shown
    const proposed = baseline.replace("Beta", "Beta by AI"); // AI edits Beta

    // Meanwhile a collaborator edits Gamma in the LIVE doc.
    frag.doc!.transact(() => {
      const g = frag.get(4) as Y.XmlElement;
      const t = g.get(0) as Y.XmlText;
      t.delete(0, t.length);
      t.insert(0, "Gamma edited");
    });

    applyMarkdownToYXmlFragment(frag, proposed, { originalMarkdown: baseline });

    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("Beta by AI"); // AI edit applied
    expect(out).toContain("Gamma edited"); // concurrent human edit survived (not clobbered)
    expect(out).not.toContain("Gamma\n\n"); // the pre-edit "Gamma" is gone (was replaced, not kept alongside)
  });

  it("with no invisible blocks, behaves exactly like the plain 3-way merge", () => {
    // With no empty paragraphs the merge is a plain block-space 3-way merge.
    const frag = freshFrag();
    const original = "Alpha\n\nBeta\n\nGamma";
    applyMarkdownToYXmlFragment(frag, original);
    const proposed = "Alpha\n\nBeta by AI\n\nGamma";
    applyMarkdownToYXmlFragment(frag, proposed, { originalMarkdown: original });
    expect(yXmlFragmentToMarkdown(frag)).toBe("Alpha\n\nBeta by AI\n\nGamma");
  });
});

describe("block diff segments (multi-region, no over-marking)", () => {
  const schema = getStugaSchema();
  const parse = (md: string) => markdownToDoc(md, schema);

  it("two scattered edits leave the UNCHANGED middle blocks alone", () => {
    // Blocks 1 and 3 change; the segments must skip the unchanged block 2 between them.
    const current = "A\n\nB\n\nC\n\nD\n\nE";
    const target = "A\n\nB2\n\nC\n\nD2\n\nE";
    const segs = blockDiffSegments(topBlocks(parse(current)), topBlocks(parse(target)));
    expect(segs.length).toBe(2);
    expect(segs[0]!.startBlock).toBe(1);
    expect(segs[0]!.endBlock).toBe(2);
    expect(segs[0]!.replacement[0]!.textContent).toBe("B2");
    expect(segs[1]!.startBlock).toBe(3);
    expect(segs[1]!.endBlock).toBe(4);
    expect(segs[1]!.replacement[0]!.textContent).toBe("D2");
    // Block 2 ("C") is never inside any segment's [start,end).
    for (const s of segs) expect(2 >= s.startBlock && 2 < s.endBlock).toBe(false);
  });

  it("a single-word change in one block yields exactly one 1-block segment", () => {
    const current = "keep\n\nchange me\n\nkeep too";
    const target = "keep\n\nchanged\n\nkeep too";
    const segs = blockDiffSegments(topBlocks(parse(current)), topBlocks(parse(target)));
    expect(segs.length).toBe(1);
    expect(segs[0]!.startBlock).toBe(1);
    expect(segs[0]!.endBlock).toBe(2);
  });

  it("pure insertion between blocks is a zero-width segment", () => {
    const current = "one\n\ntwo";
    const target = "one\n\ninserted\n\ntwo";
    const segs = blockDiffSegments(topBlocks(parse(current)), topBlocks(parse(target)));
    expect(segs.length).toBe(1);
    expect(segs[0]!.startBlock).toBe(segs[0]!.endBlock); // nothing removed
    expect(segs[0]!.replacement[0]!.textContent).toBe("inserted");
  });

  it("identical docs produce no segments", () => {
    const md = "alpha\n\nbeta\n\ngamma";
    expect(blockDiffSegments(topBlocks(parse(md)), topBlocks(parse(md)))).toEqual([]);
  });

  it("previewBlockSegments: separate edits stay separate segments bracketing the changed span", () => {
    const current = "A\n\nB\n\nC\n\nD\n\nE";
    const proposed = "A\n\nB2\n\nC\n\nD2\n\nE";
    const segs = previewBlockSegments(parse(current), proposed, current);
    expect(segs.map((g) => [g.startBlock, g.endBlock])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("top-level segments carry an empty path", () => {
    const segs = blockDiffSegments(topBlocks(parse("A\n\nB")), topBlocks(parse("A\n\nB2")));
    expect(segs).toHaveLength(1);
    expect(segs[0]!.path).toEqual([]);
  });
});

/** Descent into containers: removing one bullet marks that item, not the whole list. */
describe("block diff segments descend into containers", () => {
  const schema = getStugaSchema();
  const parse = (md: string) => markdownToDoc(md, schema);
  const segsOf = (a: string, b: string) => blockDiffSegments(topBlocks(parse(a)), topBlocks(parse(b)));
  const LIST = "Intro.\n\n- alpha\n- beta\n- gamma\n\nOutro.";

  it("removing one list item marks ONLY that item", () => {
    const segs = segsOf(LIST, "Intro.\n\n- alpha\n- gamma\n\nOutro.");
    expect(segs).toHaveLength(1);
    const seg = segs[0]!;
    expect(seg.path).toEqual([1]); // inside the list, which is top-level block 1
    expect(seg.startBlock).toBe(1); // list item 1 ("beta")
    expect(seg.endBlock).toBe(2);
    expect(seg.replacement).toEqual([]); // a pure removal — nothing ghosted back

    // Resolved against the live doc it covers exactly that item's node.
    const doc = parse(LIST);
    const at = resolveSegment(doc, seg)!;
    expect(at.parent.type.name).toBe("bulletList");
    expect(at.removed.map((n) => n.textContent)).toEqual(["beta"]);
    expect(doc.slice(at.from, at.to).content.firstChild!.textContent).toBe("beta");
    // The untouched siblings are OUTSIDE the struck range.
    expect(doc.textBetween(at.from, at.to, "\n")).not.toContain("alpha");
    expect(doc.textBetween(at.from, at.to, "\n")).not.toContain("gamma");
  });

  it("editing one item's text descends to the item's paragraph", () => {
    const segs = segsOf(LIST, "Intro.\n\n- alpha\n- beta EDITED\n- gamma\n\nOutro.");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.path).toEqual([1, 1]); // list → item 1 → its paragraph
    expect(segs[0]!.replacement[0]!.textContent).toBe("beta EDITED");
    const at = resolveSegment(parse(LIST), segs[0]!)!;
    expect(at.parent.type.name).toBe("listItem");
    expect(at.removed[0]!.textContent).toBe("beta");
  });

  it("inserting an item mid-list is a zero-width segment inside the list", () => {
    const segs = segsOf(LIST, "Intro.\n\n- alpha\n- inserted\n- beta\n- gamma\n\nOutro.");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.path).toEqual([1]);
    expect(segs[0]!.startBlock).toBe(segs[0]!.endBlock); // nothing removed
    expect(segs[0]!.replacement[0]!.textContent).toBe("inserted");
    const at = resolveSegment(parse(LIST), segs[0]!)!;
    expect(at.from).toBe(at.to);
    expect(at.removed).toEqual([]);
  });

  it("two edited items are two separate segments, not one run", () => {
    // Even ADJACENT items: a 1:1 run is split so each is independently
    // reviewable (accept one, reject the other).
    const four = "- one\n- two\n- three\n- four";
    const segs = segsOf(four, "- one\n- TWO\n- THREE\n- four");
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.path)).toEqual([
      [0, 1],
      [0, 2],
    ]);
  });

  it("descends into a table's ROWS but not into its cells", () => {
    const base = "| Name | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |";
    const segs = segsOf(base, "| Name | Qty |\n| --- | --- |\n| Apples | 7 |\n| Pears | 5 |");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.path).toEqual([0]); // inside the table
    expect(segs[0]!.startBlock).toBe(1); // the "Apples" row
    const at = resolveSegment(parse(base), segs[0]!)!;
    expect(at.parent.type.name).toBe("table");
    expect(at.removed[0]!.type.name).toBe("tableRow");
  });

  it("descends into a blockquote's paragraphs", () => {
    const base = "> one\n>\n> two\n>\n> three";
    const segs = segsOf(base, "> one\n>\n> two changed\n>\n> three");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.path).toEqual([0]);
    const at = resolveSegment(parse(base), segs[0]!)!;
    expect(at.parent.type.name).toBe("blockquote");
    expect(at.removed[0]!.textContent).toBe("two");
  });

  it("descends through a NESTED list to the inner item", () => {
    const base = "- outer one\n  - inner a\n  - inner b\n- outer two";
    const segs = segsOf(base, "- outer one\n  - inner a\n  - inner B\n- outer two");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.path.length).toBeGreaterThan(2); // list → item → inner list → item
    const at = resolveSegment(parse(base), segs[0]!)!;
    expect(at.removed[0]!.textContent).toBe("inner b");
  });

  it("does NOT descend when the container itself changed markup", () => {
    // A bullet list becoming an ordered list is a change to the CONTAINER; a
    // child-level diff would silently drop it.
    const segs = segsOf("- a\n- b", "1. a\n2. b");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.path).toEqual([]);
    expect(segs[0]!.replacement[0]!.type.name).toBe("orderedList");
  });

  it("does not descend into paragraphs, headings or code blocks", () => {
    const doc = parse("# H\n\npara\n\n```\ncode\n```\n\n- item");
    const [heading, para, code, list] = topBlocks(doc);
    expect(isDescendableContainer(heading!)).toBe(false);
    expect(isDescendableContainer(para!)).toBe(false);
    expect(isDescendableContainer(code!)).toBe(false);
    expect(isDescendableContainer(list!)).toBe(true);
  });

  it("resolveSegment rejects a segment that does not fit the document", () => {
    const doc = parse("- a\n- b");
    expect(resolveSegment(doc, { path: [9], startBlock: 0, endBlock: 1, replacement: [] })).toBeNull();
    expect(resolveSegment(doc, { path: [0], startBlock: 0, endBlock: 99, replacement: [] })).toBeNull();
  });

  it("segments stay disjoint and in document order", () => {
    const base = "Intro.\n\n- a\n- b\n- c\n\nMiddle.\n\n> q1\n>\n> q2\n\nEnd.";
    const next = "Intro.\n\n- a\n- b CHANGED\n- c\n\nMiddle EDITED.\n\n> q1\n>\n> q2 CHANGED\n\nEnd.";
    const doc = parse(base);
    const spans = blockDiffSegments(topBlocks(doc), topBlocks(parse(next))).map((s) => resolveSegment(doc, s)!);
    expect(spans).toHaveLength(3);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.from).toBeGreaterThanOrEqual(spans[i - 1]!.to);
  });

  it("previewBlockSegments returns the same nested segments against the live doc", () => {
    const current = LIST;
    const proposed = "Intro.\n\n- alpha\n- gamma\n\nOutro.";
    const segs = previewBlockSegments(parse(current), proposed, current);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.path).toEqual([1]);
    const at = resolveSegment(parse(current), segs[0]!)!;
    expect(at.removed[0]!.textContent).toBe("beta");
  });
});

describe("blockDiffMarkdown (version compare) descends too", () => {
  it("marks the removed list ITEM, leaving its siblings equal", () => {
    const blocks = blockDiffMarkdown("Intro.\n\n- alpha\n- beta\n- gamma", "Intro.\n\n- alpha\n- gamma");
    expect(blocks).toEqual([
      { type: "eq", markdown: "Intro." },
      { type: "eq", markdown: "* alpha" },
      { type: "del", markdown: "* beta" },
      { type: "eq", markdown: "* gamma" },
    ]);
  });

  it("pairs a changed item's del with its ins", () => {
    const blocks = blockDiffMarkdown("- alpha\n- beta", "- alpha\n- beta EDITED");
    expect(blocks.map((b) => b.type)).toEqual(["eq", "del", "ins"]);
    expect(blocks[1]!.markdown).toBe("* beta");
    expect(blocks[2]!.markdown).toBe("* beta EDITED");
  });

  it("renumbers an ordered list's items so a kept item reads with its real ordinal", () => {
    const blocks = blockDiffMarkdown("1. one\n2. two\n3. three", "1. one\n2. two\n3. THREE");
    expect(blocks[1]!.markdown).toBe("2. two");
    expect(blocks[2]!.markdown).toBe("3. three");
    expect(blocks[3]!.markdown).toBe("3. THREE");
  });

  it("keeps a changed TABLE whole (a lone row has no standalone markdown)", () => {
    const base = "| Name | Qty |\n| --- | --- |\n| Apples | 3 |";
    const blocks = blockDiffMarkdown(base, "| Name | Qty |\n| --- | --- |\n| Apples | 7 |");
    expect(blocks.map((b) => b.type)).toEqual(["del", "ins"]);
    for (const b of blocks) expect(b.markdown).toContain("| --- | --- |");
  });

  it("unchanged documents are all eq", () => {
    const md = "# H\n\n- a\n- b\n\nTail.";
    expect(blockDiffMarkdown(md, md).every((b) => b.type === "eq")).toBe(true);
  });

  // The markdown diff stops at the list item: its children re-wrapped one by one would not be valid items.
  it("keeps a list item's continuation paragraph inside that item", () => {
    const base = "* item one\n\n  second para\n\n* other";
    const blocks = blockDiffMarkdown(base, "* item one\n\n  second para EDITED\n\n* other");
    expect(blocks).toEqual([
      { type: "del", markdown: "* item one\n\n  second para" },
      { type: "ins", markdown: "* item one\n\n  second para EDITED" },
      { type: "eq", markdown: "* other" },
    ]);
  });

  it("indents a nested list under its parent item instead of emitting `* * sub`", () => {
    const blocks = blockDiffMarkdown("* parent\n\n  * c1\n\n  * c2", "* parent\n\n  * c1 X\n\n  * c2");
    expect(blocks).toEqual([
      { type: "del", markdown: "* parent\n\n  * c1\n\n  * c2" },
      { type: "ins", markdown: "* parent\n\n  * c1 X\n\n  * c2" },
    ]);
    // The unchanged sub-item must never surface as a bullet of its own.
    for (const b of blocks) expect(b.markdown).not.toContain("* * ");
  });

  it("keeps a code block inside its list item", () => {
    const base = "* item\n\n  ```\n  x = 1\n  ```\n\n* other";
    const blocks = blockDiffMarkdown(base, "* item\n\n  ```\n  x = 2\n  ```\n\n* other");
    expect(blocks.map((b) => b.type)).toEqual(["del", "ins", "eq"]);
    expect(blocks[0]!.markdown).toBe("* item\n\n  ```\n  x = 1\n  ```");
    expect(blocks[1]!.markdown).toBe("* item\n\n  ```\n  x = 2\n  ```");
  });

  it("still descends the LIST itself when its items are single paragraphs", () => {
    // The guard must not cost the per-item granularity the whole feature is for.
    const blocks = blockDiffMarkdown("- a\n- b\n- c\n- d\n- e\n- f", "- a\n- b\n- d\n- e\n- f");
    expect(blocks).toEqual([
      { type: "eq", markdown: "* a" },
      { type: "eq", markdown: "* b" },
      { type: "del", markdown: "* c" },
      { type: "eq", markdown: "* d" },
      { type: "eq", markdown: "* e" },
      { type: "eq", markdown: "* f" },
    ]);
  });
});

describe("word diff", () => {
  function reconstruct(ops: ReturnType<typeof wordDiff>): { oldText: string; newText: string } {
    let oldText = "";
    let newText = "";
    for (const op of ops) {
      if (op.type !== "ins") oldText += op.text;
      if (op.type !== "del") newText += op.text;
    }
    return { oldText, newText };
  }

  it("narrows to a single changed word and round-trips both sides", () => {
    const ops = wordDiff("The quick brown fox jumps.", "The quick red fox jumps.");
    const del = ops.filter((o) => o.type === "del").map((o) => o.text.trim());
    const ins = ops.filter((o) => o.type === "ins").map((o) => o.text.trim());
    expect(del).toContain("brown");
    expect(ins).toContain("red");
    const { oldText, newText } = reconstruct(ops);
    expect(oldText).toBe("The quick brown fox jumps.");
    expect(newText).toBe("The quick red fox jumps.");
  });

  it("insert-only and delete-only", () => {
    const ins = wordDiff("hello world", "hello brave new world");
    expect(ins.some((o) => o.type === "ins")).toBe(true);
    expect(ins.some((o) => o.type === "del")).toBe(false);

    const del = wordDiff("hello brave new world", "hello world");
    expect(del.some((o) => o.type === "del")).toBe(true);
    expect(del.some((o) => o.type === "ins")).toBe(false);
  });

  it("identical text is all eq", () => {
    const ops = wordDiff("same text here", "same text here");
    expect(ops.every((o) => o.type === "eq")).toBe(true);
  });

  it("trims the common prefix/suffix so only the changed middle is del/ins", () => {
    const ops = wordDiff("the cat sat on the mat", "the cat ran on the mat");
    // Leading "the cat " and trailing " on the mat" stay eq; only sat→ran changes.
    expect(ops.filter((o) => o.type === "del").map((o) => o.text.trim())).toEqual(["sat"]);
    expect(ops.filter((o) => o.type === "ins").map((o) => o.text.trim())).toEqual(["ran"]);
  });

  it("caps huge inputs: collapses to one del + one ins instead of an O(n*m) matrix", () => {
    // A pathologically long block (well over the token cap) with a fully different
    // middle must not allocate a giant LCS table — it falls back to del+ins.
    const oldText = Array.from({ length: 4000 }, (_, i) => `a${i}`).join(" ");
    const newText = Array.from({ length: 4000 }, (_, i) => `b${i}`).join(" ");
    const start = performance.now();
    const ops = wordDiff(oldText, newText);
    expect(performance.now() - start).toBeLessThan(500); // no multi-million-cell matrix
    const { oldText: o, newText: n } = reconstruct(ops);
    expect(o).toBe(oldText);
    expect(n).toBe(newText);
    // No eq run survives a fully-different body (prefix/suffix share nothing).
    expect(ops.some((op) => op.type === "del")).toBe(true);
    expect(ops.some((op) => op.type === "ins")).toBe(true);
  });
});

describe("applyStrEdits", () => {
  it("replaces the first occurrence of an exact match", () => {
    expect(applyStrEdits("the old wording here", [{ old_string: "old wording", new_string: "new text" }])).toBe(
      "the new text here",
    );
  });

  it("appends when old_string is empty (insert_text on an empty/append)", () => {
    expect(applyStrEdits("", [{ old_string: "", new_string: "First line." }])).toBe("First line.");
    expect(applyStrEdits("Existing.", [{ old_string: "", new_string: "\n\nAdded." }])).toBe("Existing.\n\nAdded.");
  });

  it("applies edits in order, composing (a later edit targets an earlier edit's output)", () => {
    const out = applyStrEdits("start AAA end", [
      { old_string: "AAA", new_string: "BBB" },
      { old_string: "BBB", new_string: "CCC" },
    ]);
    expect(out).toBe("start CCC end");
  });

  it("skips an edit whose old_string no longer matches (no corruption)", () => {
    const out = applyStrEdits("hello world", [
      { old_string: "gone", new_string: "X" },
      { old_string: "world", new_string: "there" },
    ]);
    expect(out).toBe("hello there");
  });

  it("deletes with an empty new_string", () => {
    expect(applyStrEdits("keep [drop] this", [{ old_string: "[drop] ", new_string: "" }])).toBe("keep this");
  });

  it("applies an edit whose old_string differs only by typography (smart quotes / dash / NBSP)", () => {
    // Doc has smart quotes + em-dash; the model's old_string uses ASCII equivalents.
    // The fuzzy match must locate it and replace the REAL doc bytes.
    const doc = "Intro. The team’s “goal” — ship — is set. Outro.";
    const out = applyStrEdits(doc, [
      { old_string: 'The team\'s "goal" - ship - is set.', new_string: "Rewritten." },
    ]);
    expect(out).toBe("Intro. Rewritten. Outro.");
  });
});

// The index job carries a snapshot key; the consumer decodes the blob into a fresh
// Y.Doc, which must serialize exactly as the live doc does.
describe("blob snapshot round-trip (the job carries a key, not the body)", () => {
  it("encode→decode→serialize equals serializing the live doc", () => {
    const md = [
      "# Report",
      "",
      "Intro paragraph with **bold**, *italic*, `code`, and ~~strike~~.",
      "",
      "## Section",
      "",
      "- alpha",
      "- beta",
      "",
      "> a quote",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");

    // Build a live doc the way the DocActor holds it.
    const live = new Y.Doc();
    applyMarkdownToYXmlFragment(live.getXmlFragment("default"), md);
    const liveMarkdown = yXmlFragmentToMarkdown(live.getXmlFragment("default"));

    // The DocActor → blob store write.
    const blob = Y.encodeStateAsUpdate(live);

    // The consumer's path: fresh doc, apply the blob, serialize.
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, blob);
    const decodedMarkdown = yXmlFragmentToMarkdown(decoded.getXmlFragment("default"));

    expect(decodedMarkdown).toBe(liveMarkdown);
    expect(decodedMarkdown).toContain("# Report");
    expect(decodedMarkdown).toContain("## Section");
    expect(decodedMarkdown).toContain("```js");
  });

  it("preserves footnotes (AI citations) through the snapshot round-trip", () => {
    const md = [
      "Fact one [^1] and fact two [^2].",
      "",
      "## Sources",
      "",
      '[^1]: [Source A](/doc/abc) "Excerpt A."',
      "[^2]: Plain definition.",
    ].join("\n");
    const live = new Y.Doc();
    applyMarkdownToYXmlFragment(live.getXmlFragment("default"), md);

    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, Y.encodeStateAsUpdate(live));

    const out = yXmlFragmentToMarkdown(decoded.getXmlFragment("default"));
    expect(out).toBe(yXmlFragmentToMarkdown(live.getXmlFragment("default")));
    expect(out).toContain("[^1]");
    expect(out).toContain("[^1]: [Source A](/doc/abc)");
  });
});

// Images are block nodes here, so the tokenizer hoists them out of paragraphs.
// No text may ever be lost in the split.
describe("inline images", () => {
  const names = (doc: PMNode): string[] => {
    const out: string[] = [];
    doc.content.forEach((c) => out.push(c.type.name));
    return out;
  };
  const parse = (md: string): PMNode => markdownToDoc(md, getStugaSchema());
  const imagesIn = (doc: PMNode): { src: string; alt: string | null; title: string | null }[] => {
    const out: { src: string; alt: string | null; title: string | null }[] = [];
    doc.descendants((n) => {
      if (n.type.name === "image") out.push({ src: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title });
      return true;
    });
    return out;
  };

  it("parses an image alone as a block image node (not dropped)", () => {
    const doc = parse("![alt](pic.png)");
    expect(names(doc)).toEqual(["image"]);
    expect(imagesIn(doc)).toEqual([{ src: "pic.png", alt: "alt", title: null }]);
    expect(docToMarkdown(doc).trim()).toBe("![alt](pic.png)");
  });

  it("keeps the title attr", () => {
    expect(imagesIn(parse('![alt](pic.png "the title")'))).toEqual([
      { src: "pic.png", alt: "alt", title: "the title" },
    ]);
  });

  it("keeps an image in its own paragraph between other blocks", () => {
    const doc = parse("# T\n\n![alt](pic.png)\n\nafter");
    expect(names(doc)).toEqual(["heading", "image", "paragraph"]);
    const out = docToMarkdown(doc);
    expect(out).toContain("# T");
    expect(out).toContain("![alt](pic.png)");
    expect(out).toContain("after");
  });

  it("splits the paragraph around an inline image — text before AND after survives", () => {
    const doc = parse("text before ![alt](pic.png) text after");
    expect(names(doc)).toEqual(["paragraph", "image", "paragraph"]);
    expect(doc.child(0).textContent).toBe("text before");
    expect(doc.child(2).textContent).toBe("text after");
    const out = docToMarkdown(doc);
    expect(out).toContain("text before");
    expect(out).toContain("![alt](pic.png)");
    expect(out).toContain("text after");
  });

  it("hoists a badge image out of its link wrapper (link_open/image/link_close)", () => {
    const doc = parse("[![CI](https://b.svg)](https://ci.example.com)");
    expect(names(doc)).toEqual(["image"]);
    expect(imagesIn(doc)).toEqual([{ src: "https://b.svg", alt: "CI", title: null }]);
  });


  it("keeps the surrounding marks when an image sits inside them", () => {
    const doc = parse("a **bold ![x](y.png) more** z");
    const out = docToMarkdown(doc);
    expect(out).toContain("![x](y.png)");
    for (const word of ["a", "bold", "more", "z"]) expect(out).toContain(word);
  });

  it("handles two images in one paragraph", () => {
    const doc = parse("one ![a](a.png) two ![b](b.png) three");
    expect(names(doc)).toEqual(["paragraph", "image", "paragraph", "image", "paragraph"]);
    expect(imagesIn(doc).map((i) => i.src)).toEqual(["a.png", "b.png"]);
    expect([doc.child(0), doc.child(2), doc.child(4)].map((n) => n.textContent)).toEqual(["one", "two", "three"]);
  });

  it("emits no empty paragraph for whitespace-only runs around an image", () => {
    expect(names(parse("  ![a](x.png)  "))).toEqual(["image"]);
    expect(names(parse("![a](x.png) caption"))).toEqual(["image", "paragraph"]);
    expect(names(parse("caption ![a](x.png)"))).toEqual(["paragraph", "image"]);
  });

  it("hoists an image inside a list item without losing the item's text", () => {
    const doc = parse("- item ![a](i.png) tail\n- plain");
    expect(names(doc)).toEqual(["bulletList"]);
    expect(imagesIn(doc).map((i) => i.src)).toEqual(["i.png"]);
    expect(doc.textContent).toContain("item");
    expect(doc.textContent).toContain("tail");
    expect(doc.textContent).toContain("plain");
  });

  it("hoists an image inside a blockquote", () => {
    const doc = parse("> quoted ![a](i.png) more");
    expect(names(doc)).toEqual(["blockquote"]);
    expect(imagesIn(doc).map((i) => i.src)).toEqual(["i.png"]);
    expect(doc.textContent).toContain("quoted");
    expect(doc.textContent).toContain("more");
  });

  it("hoists an image inside a table cell, keeping the cell's text", () => {
    const doc = parse("| a ![x](y.png) b | c |\n|---|---|\n| 1 | 2 |");
    expect(names(doc)).toEqual(["table"]);
    expect(imagesIn(doc).map((i) => i.src)).toEqual(["y.png"]);
    for (const t of ["a", "b", "c", "1", "2"]) expect(doc.textContent).toContain(t);
    // GFM cells hold inline markdown, so the hoisted image serializes back into
    // the cell rather than being silently dropped.
    expect(docToMarkdown(doc)).toContain("![x](y.png)");
  });

  it("keeps a heading's text when it contains an image (image itself is a documented loss)", () => {
    const doc = parse("# H with ![a](i.png) tail");
    expect(names(doc)).toEqual(["heading"]);
    // heading content is `inline*` — no block image fits, so drop the image and
    // close the gap it left rather than leaving a double space.
    expect(doc.child(0).textContent).toBe("H with tail");
    expect(imagesIn(doc)).toEqual([]);
    expect(docToMarkdown(doc).trim()).toBe("# H with tail");
  });

  it("keeps a heading's text when the image LEADS the heading", () => {
    const doc = parse("# ![lead](x.png) heading text");
    expect(names(doc)).toEqual(["heading"]);
    expect(doc.child(0).textContent).toBe("heading text");
  });

  it("keeps a footnote reference AND the image in the same paragraph", () => {
    const doc = parse("para ![a](i.png) with ref [^1]\n\n[^1]: the def");
    expect(names(doc)).toEqual(["paragraph", "image", "paragraph", "footnoteDefinition"]);
    expect(imagesIn(doc).map((i) => i.src)).toEqual(["i.png"]);
    const refs: number[] = [];
    doc.descendants((n) => {
      if (n.type.name === "footnoteReference") refs.push(n.attrs.n);
      return true;
    });
    expect(refs).toEqual([1]);
    const out = docToMarkdown(doc);
    expect(out).toContain("para");
    expect(out).toContain("with ref [^1]");
    expect(out).toContain("[^1]: the def");
  });

  it("keeps a footnote definition's text when the definition contains an image", () => {
    const doc = parse("ref [^1]\n\n[^1]: def ![b](j.png) end");
    const out = docToMarkdown(doc);
    expect(out).toContain("[^1]: def");
    expect(out).toContain("end"); // definition text survives; the block image can't
  });

  it("leaves image-free content completely untouched (no stray splits, marks intact)", () => {
    const md = [
      "# Heading",
      "",
      "Some **bold** and [a link](https://x.dev) and *italic* and `code` text.",
      "",
      "- one",
      "- two",
      "",
      "> quote",
    ].join("\n");
    const doc = parse(md);
    expect(names(doc)).toEqual(["heading", "paragraph", "bulletList", "blockquote"]);
    // ONE paragraph, unsplit, with every mark still on its own run.
    const para = doc.child(1);
    expect(para.textContent).toBe("Some bold and a link and italic and code text.");
    const marks: string[][] = [];
    para.content.forEach((c) => marks.push(c.marks.map((m) => m.type.name)));
    expect(marks).toEqual([[], ["bold"], [], ["link"], [], ["italic"], [], ["code"], []]);
    const out = docToMarkdown(doc);
    for (const frag of ["# Heading", "**bold**", "[a link](https://x.dev)", "*italic*", "`code`", "> quote"]) {
      expect(out).toContain(frag);
    }
  });

  it("survives the full CRDT bridge (the AI/MCP write path) without losing prose", () => {
    const frag = freshFrag();
    applyMarkdownToYXmlFragment(frag, "# Stuga\n\n[![CI](https://b.svg)](https://ci.com)\n\nreal prose");
    expect(nodeNames(frag)).toEqual(["heading", "image", "paragraph"]);
    const out = yXmlFragmentToMarkdown(frag);
    expect(out).toContain("real prose");
    expect(out).toContain("![CI](https://b.svg)");
    // idempotent: re-applying its own output changes nothing structural
    const frag2 = freshFrag();
    applyMarkdownToYXmlFragment(frag2, out);
    expect(nodeNames(frag2)).toEqual(nodeNames(frag));
    expect(yXmlFragmentToMarkdown(frag2)).toBe(out);
  });

  it("round-trips text+image+text through markdown twice (stable)", () => {
    const once = docToMarkdown(parse("text before ![alt](pic.png) text after"));
    const twice = docToMarkdown(parse(once));
    expect(twice).toBe(once);
  });
});
