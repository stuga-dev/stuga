// @vitest-environment jsdom
// A mention in a document reads with the person's name as it is now, whatever label it was inserted with.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor } from "@tiptap/react";

const users = vi.hoisted(() => ({ resolve: vi.fn(async () => ({ users: [] as unknown[] })) }));
vi.mock("../api", async (orig) => {
  const api = await orig<typeof import("../api")>();
  return { ...api, Users: { ...api.Users, resolve: users.resolve } };
});

const { stugaEditorExtensions } = await import("./extensions");
const { rememberUsers } = await import("../state/identity");

let editor: Editor | null = null;

function mount(alias: string, label: string): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const ydoc = new Y.Doc();
  editor = new Editor({
    element,
    extensions: stugaEditorExtensions({ ydoc, awareness: new Awareness(ydoc), alias: "tester", onClickComment: () => {} }),
  });
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { alias, label } }] }],
  });
  return editor.view.dom.querySelector<HTMLElement>("[data-mention]")!;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("a mention chip", () => {
  it("shows the label it was inserted with until the name is known", () => {
    const chip = mount("u_nadia", "nadia");
    expect(chip.textContent).toBe("@nadia");
  });

  it("names the person as the directory knows them now, and updates when the name arrives", () => {
    const chip = mount("u_sofia", "sofia");
    rememberUsers([{ alias: "u_sofia", username: "sofia", display_name: "Sofia Reyes-Alvarez", email: null }]);

    expect(chip.textContent).toBe("@Sofia Reyes-Alvarez");
    expect(chip.title).toBe("@sofia");
  });

  it("keeps the label in the document itself, for Markdown and agents", () => {
    rememberUsers([{ alias: "u_ben", username: "ben", display_name: "Ben Baker", email: null }]);
    mount("u_ben", "ben");

    const mention = editor!.getJSON().content![0]!.content![1] as { attrs?: unknown };
    expect(mention.attrs).toEqual({ alias: "u_ben", label: "ben" });
  });
});
