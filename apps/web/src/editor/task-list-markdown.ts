/** Task boxes for the read-only markdown renderers, matching the editor's task lists. */
import type MarkdownIt from "markdown-it";

type Md = InstanceType<typeof MarkdownIt>;

/** As the document's parser reads it: `[ ]` or `[x]` opening a list item's text, then a space or nothing. */
const TASK_BOX = /^\[([ xX])\](?:[ \t]+|$)/;

/**
 * A list item that opens with a task box shows a checkbox that cannot be changed, and its list
 * loses its bullets. `html: false` limits raw HTML in the input, not what a rule emits.
 */
export function renderTaskBoxes(md: Md): void {
  md.core.ruler.push("task_boxes", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i]!;
      if (inline.type !== "inline" || tokens[i - 1]!.type !== "paragraph_open" || tokens[i - 2]!.type !== "list_item_open") continue;
      const first = inline.children?.[0];
      const m = TASK_BOX.exec(inline.content);
      if (!m || first?.type !== "text" || !first.content.startsWith(m[0])) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" class="task-box" disabled${m[1] === " " ? "" : " checked"}> `;
      inline.children!.unshift(box);
      tokens[i - 2]!.attrJoin("class", "task-item");
    }
  });
}
