// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";

vi.mock("../use-editor-tick", () => ({ useEditorTick: () => {} }));
vi.mock("./BlockTypeMenu", () => ({ BlockTypeMenu: () => <button>Text style</button> }));
vi.mock("./TableSizePicker", () => ({ TableSizePicker: () => <button>Insert table</button> }));

const { EditorToolbar } = await import("./EditorToolbar");

function fakeEditor(inTable = false) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of [
    "focus", "toggleBold", "toggleItalic", "toggleUnderline", "toggleStrike", "toggleCode",
    "toggleBulletList", "toggleOrderedList", "toggleBlockquote", "setHorizontalRule",
    "undo", "redo", "addColumnBefore", "addColumnAfter", "addRowBefore", "addRowAfter",
    "toggleHeaderRow", "mergeOrSplit", "deleteRow", "deleteColumn", "deleteTable",
  ]) chain[name] = vi.fn(() => chain);
  chain.run = vi.fn();
  const editor = {
    isActive: (name: string) => inTable && name === "table",
    chain: () => chain,
    can: () => ({ undo: () => true, redo: () => true }),
  } as unknown as Editor;
  return { editor, chain };
}

let host: HTMLDivElement;
let root: Root;

async function mount(editor: Editor) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<EditorToolbar editor={editor} onEditLink={() => {}} onPickImages={() => {}} />));
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  expect(button, `Missing ${label}`).toBeTruthy();
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function clickMenuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) => el.textContent?.includes(label));
  expect(item, `Missing menu item ${label}`).toBeTruthy();
  await act(async () => item!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

describe("EditorToolbar", () => {
  it("keeps common formatting visible and runs advanced commands from menus", async () => {
    const { editor, chain } = fakeEditor();
    await mount(editor);
    expect(host.querySelector('[aria-label="Bold (⌘B)"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Strikethrough"]')).toBeNull();

    await clickButton("More formatting");
    await clickMenuItem("Strikethrough");
    expect(chain.toggleStrike).toHaveBeenCalledOnce();
    expect(chain.run).toHaveBeenCalledOnce();

    await clickButton("Insert");
    await clickMenuItem("Divider");
    expect(chain.setHorizontalRule).toHaveBeenCalledOnce();
  });

  it("groups contextual table edits in one menu", async () => {
    const { editor, chain } = fakeEditor(true);
    await mount(editor);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Insert table"))).toBe(false);

    await clickButton("Table tools");
    await clickMenuItem("Add row above");
    expect(chain.addRowBefore).toHaveBeenCalledOnce();
  });
});
