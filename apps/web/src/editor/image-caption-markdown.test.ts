import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { renderImageCaptions } from "./image-caption-markdown";

const PATH = `/api/docs/d1/media/${"b".repeat(64)}`;

describe("image captions in markdown-it surfaces", () => {
  function surface(): InstanceType<typeof MarkdownIt> {
    const md = new MarkdownIt({ html: false });
    renderImageCaptions(md);
    return md;
  }

  it("wraps a titled image in a figure with its caption", () => {
    const html = surface().render(`![Bar chart](${PATH} "Fig 1 — Q3 revenue")`);
    expect(html).toContain('<figure class="stuga-image-figure">');
    expect(html).toContain(`src="${PATH}"`);
    expect(html).toContain('<figcaption class="stuga-image-caption">Fig 1 — Q3 revenue</figcaption>');
  });

  it("leaves an uncaptioned image as a bare img", () => {
    const html = surface().render(`![Bar chart](${PATH})`);
    expect(html).not.toContain("<figure");
    expect(html).not.toContain("<figcaption");
  });

  it("escapes markup in a caption", () => {
    // `html: false` covers the source, not a value this rule interpolates.
    const html = surface().render(`![a](${PATH} "<img src=x onerror=alert(1)>")`);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("does not caption a link that carries a title", () => {
    const html = surface().render(`[link](${PATH} "just a tooltip")`);
    expect(html).not.toContain("<figcaption");
  });
});
