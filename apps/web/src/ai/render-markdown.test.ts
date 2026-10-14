/** Citation markers in an assistant answer: chips where a source exists, nothing where none ever will. */
import { describe, expect, it } from "vitest";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import { renderAssistantHtml } from "./render-markdown";

const cite = (n: number): AiCitation => ({ n, doc_id: `d${n}`, title: `Doc ${n}`, content: "passage" }) as AiCitation;

describe("renderAssistantHtml citation markers", () => {
  it("drops a footnote marker no source matches, with the space before it, once the answer is finished", () => {
    expect(renderAssistantHtml("Freestanding, so the first half can go [^1].")).toBe("<p>Freestanding, so the first half can go.</p>\n");
  });

  it("keeps a plain bracketed number, which may be the text's own", () => {
    expect(renderAssistantHtml("Use array[0] here.")).toBe("<p>Use array[0] here.</p>\n");
  });

  it("leaves markers inside code alone", () => {
    expect(renderAssistantHtml("Write `[^1]` for a footnote.")).toBe("<p>Write <code>[^1]</code> for a footnote.</p>\n");
  });

  it("turns a matched marker into a chip and drops an unmatched one beside it", () => {
    const html = renderAssistantHtml("Tiles are white [^1] and grout matte [^2].", [cite(1)]);
    expect(html).toContain('data-cite-raw="1"');
    expect(html).not.toContain("[^2]");
    expect(html).toContain("grout matte.");
  });

  it("shows an inert chip while the answer streams, before its sources arrive", () => {
    expect(renderAssistantHtml("Tiles are white [^1]", [], { pending: true })).toContain("citation-ref--pending");
  });
});
