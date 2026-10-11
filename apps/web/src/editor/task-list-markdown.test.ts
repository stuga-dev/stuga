import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { renderTaskBoxes } from "./task-list-markdown";

const md = new MarkdownIt({ html: false });
renderTaskBoxes(md);

describe("task boxes in read-only markdown", () => {
  it("shows a ticked and an open box in place of the literal brackets", () => {
    const html = md.render("* [x] Turn on ovens\n* [ ] Unlock back door");
    expect(html).toContain('<li class="task-item"><input type="checkbox" class="task-box" disabled checked> Turn on ovens</li>');
    expect(html).toContain('<input type="checkbox" class="task-box" disabled> Unlock back door');
    expect(html).not.toContain("[x]");
  });

  it("leaves escaped brackets and brackets outside a list alone", () => {
    expect(md.render("* \\[ \\] typed")).toContain("<li>[ ] typed</li>");
    expect(md.render("[ ] typed")).not.toContain("checkbox");
  });
});
