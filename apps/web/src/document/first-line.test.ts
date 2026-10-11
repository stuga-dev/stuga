/** The first line names a document as the node will once it indexes it (doc-actor text-extract deriveTitle). */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyMarkdownToYXmlFragment } from "@stuga/crdt-ops";
import { firstLine } from "./first-line";

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  applyMarkdownToYXmlFragment(doc.getXmlFragment("default"), markdown);
  return doc;
}

describe("firstLine", () => {
  it("keeps a heading's formatted runs on one line", () => {
    expect(firstLine(docOf("# The `x` Flag\n\nbody text"))).toBe("The x Flag");
  });

  it("skips empty blocks and trims", () => {
    expect(firstLine(docOf("\n\n   \n\nBakery handbook  \n\nBody"))).toBe("Bakery handbook");
  });

  it("ends the line at a hard break", () => {
    expect(firstLine(docOf("line one\\\nline two"))).toBe("line one");
  });

  it("names a list or a table by its first item or cell", () => {
    expect(firstLine(docOf("* one\n* two"))).toBe("one");
    expect(firstLine(docOf("| Name | Owner |\n| --- | --- |\n| a | b |"))).toBe("Name");
  });

  it("is empty for an empty document, and cut where the node cuts it", () => {
    expect(firstLine(new Y.Doc())).toBe("");
    expect(firstLine(docOf("a".repeat(250)))).toHaveLength(200);
  });
});
