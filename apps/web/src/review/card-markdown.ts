/**
 * An AI change's Markdown as the review card shows it: rendered inert (`html: false` escapes raw
 * HTML, so the output is safe to inject), with each footnote marker a small number that matches the
 * sources listed under the change.
 */
import MarkdownIt from "markdown-it";
import { renderImageCaptions } from "../editor/image-caption-markdown";
import { renderTextDirection } from "../editor/text-direction-markdown";
import { renderTaskBoxes } from "../editor/task-list-markdown";

const md = new MarkdownIt({ html: false, linkify: true });
renderImageCaptions(md);
renderTextDirection(md);
renderTaskBoxes(md);

const MARKER = /\[\^(\d+)\](?!:)/g;

md.renderer.rules.text = (tokens, idx) => {
  const content = tokens[idx]!.content;
  if (!content.includes("[^")) return md.utils.escapeHtml(content);
  let out = "";
  let last = 0;
  for (const m of content.matchAll(MARKER)) {
    out += md.utils.escapeHtml(content.slice(last, m.index));
    out += `<sup class="review-card-cite">${m[1]}</sup>`;
    last = m.index + m[0].length;
  }
  return out + md.utils.escapeHtml(content.slice(last));
};

export function renderCardMarkdown(markdown: string): string {
  return md.render(markdown);
}
