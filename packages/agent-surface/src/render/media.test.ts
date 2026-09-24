import { describe, expect, it } from "vitest";
import { imageMarkdown, renderUpload } from "./media.js";

describe("imageMarkdown", () => {
  it("puts the caption in the title slot", () => {
    expect(imageMarkdown("/api/docs/d1/media/abc", "A chart", "Figure 1 — quarterly revenue")).toBe(
      '![A chart](/api/docs/d1/media/abc "Figure 1 — quarterly revenue")',
    );
  });

  it("escapes brackets in alt", () => {
    expect(imageMarkdown("/p", "a [b] c", undefined)).toBe("![a \\[b\\] c](/p)");
  });

  it("escapes quotes inside a caption the way the document serializer does", () => {
    expect(imageMarkdown("/p", "", 'He said "hi"')).toBe('![](/p "He said \\"hi\\"")');
  });

  it("omits the title slot for a blank caption", () => {
    expect(imageMarkdown("/p", "alt", "   ")).toBe("![alt](/p)");
    expect(imageMarkdown("/p", undefined, undefined)).toBe("![](/p)");
  });
});

describe("renderUpload", () => {
  it("returns the stored image, ready-to-paste Markdown, and a note that it is not placed yet", () => {
    const [json, note] = renderUpload({ url: "/api/docs/d1/media/abc", hash: "abc", size: 10, mime: "image/png" }, "alt", "cap").split("\n");
    expect(JSON.parse(json!)).toEqual({
      url: "/api/docs/d1/media/abc",
      hash: "abc",
      size: 10,
      mime: "image/png",
      markdown: '![alt](/api/docs/d1/media/abc "cap")',
    });
    expect(note).toContain("uploading does not place the image by itself");
  });
});
