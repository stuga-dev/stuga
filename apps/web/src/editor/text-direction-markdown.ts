/** Text direction for the read-only markdown renderers, matching the editor. */
import type MarkdownIt from "markdown-it";

type Md = InstanceType<typeof MarkdownIt>;

const FIRST_TEXT_DIRECTION = new Set(["bullet_list_open", "ordered_list_open", "blockquote_open"]);

/**
 * Lists and quotes take the direction of their first text (`dir="auto"`), so an
 * Arabic list has its markers on the right. The stylesheet gives every other
 * block the direction of its own text.
 */
export function renderTextDirection(md: Md): void {
  md.core.ruler.push("text_direction", (state) => {
    for (const token of state.tokens) {
      if (FIRST_TEXT_DIRECTION.has(token.type)) token.attrSet("dir", "auto");
    }
  });
}
