// @vitest-environment jsdom
/**
 * The editor and server-side markdown commits write the same Y.XmlFragment, so
 * their schemas must match: a difference is rewritten on every accepted agent
 * edit and makes the review overlay see phantom edits. Deliberate non-schema
 * differences are named below.
 */
import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/react";
import { DOMParser, DOMSerializer, type Schema } from "@tiptap/pm/model";
import * as Y from "yjs";
import { getStugaSchema } from "@stuga/crdt-ops";
import { stugaEditorExtensions } from "./extensions";

function editorSchema(): Schema {
  return getSchema(
    stugaEditorExtensions({
      ydoc: new Y.Doc(),
      awareness: {},
      alias: "tester",
      onClickComment: () => {},
    }),
  ) as unknown as Schema;
}

/** Attr names and defaults: what the CRDT encoding sees. */
function attrsOf(attrs: Record<string, { default?: unknown }>): string[] {
  return Object.keys(attrs)
    .sort()
    .map((k) => {
      const spec = attrs[k]!;
      return `${k}=${"default" in spec ? JSON.stringify(spec.default) : "<required>"}`;
    });
}

describe("editor schema parity with @stuga/crdt-ops", () => {
  const editor = editorSchema();
  const server = getStugaSchema();

  it("mounts exactly the same nodes", () => {
    // As a set: node order is encoded nowhere, and the editor mounts codeBlock after StarterKit.
    expect(Object.keys(editor.nodes).sort()).toEqual(Object.keys(server.nodes).sort());
  });

  it("mounts exactly the same marks, in the same rank order", () => {
    // Mark rank decides nesting on markdown export.
    expect(Object.keys(editor.marks)).toEqual(Object.keys(server.marks));
  });

  it("agrees on every node's attrs, content and structural flags", () => {
    for (const name of Object.keys(server.nodes)) {
      const a = editor.nodes[name]!;
      const b = server.nodes[name]!;
      expect(attrsOf(a.spec.attrs ?? {}), `node ${name}: attrs`).toEqual(attrsOf(b.spec.attrs ?? {}));
      expect(a.spec.content ?? null, `node ${name}: content`).toBe(b.spec.content ?? null);
      expect(a.spec.group ?? null, `node ${name}: group`).toBe(b.spec.group ?? null);
      expect(a.spec.marks ?? null, `node ${name}: marks`).toBe(b.spec.marks ?? null);
      expect(a.isInline, `node ${name}: inline`).toBe(b.isInline);
      expect(a.isAtom, `node ${name}: atom`).toBe(b.isAtom);
    }
  });

  it("agrees on every mark's attrs and exclusions", () => {
    for (const name of Object.keys(server.marks)) {
      const a = editor.marks[name]!;
      const b = server.marks[name]!;
      expect(attrsOf(a.spec.attrs ?? {}), `mark ${name}: attrs`).toEqual(attrsOf(b.spec.attrs ?? {}));
      expect(a.spec.excludes ?? null, `mark ${name}: excludes`).toBe(b.spec.excludes ?? null);
      // `inclusive` is editing behaviour, not encoding: StugaLink turns it off.
    }
  });

  it("gives both list nodes the same attrs (tiptap-markdown's `tight` stays off)", () => {
    // tiptap-markdown adds a `tight` attr to both list types.
    for (const name of ["bulletList", "orderedList"]) {
      expect(Object.keys(editor.nodes[name]!.spec.attrs ?? {}), `node ${name}`).not.toContain("tight");
    }
  });

  it("parses a loose pasted list into the same node the server schema produces", () => {
    const html = "<ul><li><p>alpha</p></li><li><p>bravo</p></li></ul><ol><li><p>one</p></li><li><p>two</p></li></ol>";
    const parse = (schema: Schema) => {
      const dom = new window.DOMParser().parseFromString(html, "text/html");
      return DOMParser.fromSchema(schema).parse(dom.body).toJSON();
    };
    expect(parse(editor)).toEqual(parse(server));
  });

  it("renders lists and quotes with dir=auto, a DOM attribute the document never holds", () => {
    const html = '<ul dir="rtl"><li><p>أ</p></li></ul><ol><li><p>b</p></li></ol><blockquote><p>ج</p></blockquote>';
    const dom = new window.DOMParser().parseFromString(html, "text/html");
    const doc = DOMParser.fromSchema(editor).parse(dom.body);
    // Parsing drops a pasted `dir`, so both schemas hold the same document.
    expect(doc.toJSON()).toEqual(DOMParser.fromSchema(server).parse(dom.body).toJSON());
    const out = document.createElement("div");
    out.appendChild(DOMSerializer.fromSchema(editor).serializeFragment(doc.content));
    expect([...out.children].map((el) => `${el.tagName.toLowerCase()} ${el.getAttribute("dir")}`)).toEqual([
      "ul auto",
      "ol auto",
      "blockquote auto",
    ]);
    expect(out.querySelector("p")!.hasAttribute("dir")).toBe(false);
  });
});
