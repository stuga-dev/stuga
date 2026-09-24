/** Image captions for the read-only markdown renderers, matching the editor. */
import type MarkdownIt from "markdown-it";

type Md = InstanceType<typeof MarkdownIt>;
type RenderRule = NonNullable<Md["renderer"]["rules"]["image"]>;

const defaultImageRule: RenderRule = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);
}

/**
 * Renders an image's title (`![alt](src "caption")`) as a figcaption. `html:
 * false` limits raw HTML in the input, not what a render rule emits.
 */
export function renderImageCaptions(md: Md): void {
  const base = md.renderer.rules.image ?? defaultImageRule;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const html = base(tokens, idx, options, env, self);
    const caption = String(tokens[idx]!.attrGet("title") ?? "").trim();
    if (!caption) return html;
    return `<figure class="stuga-image-figure">${html}<figcaption class="stuga-image-caption">${escapeHtml(caption)}</figcaption></figure>`;
  };
}
