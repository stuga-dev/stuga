// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { mountInto } from "../../test/form-input";

vi.mock("../use-editor-tick", () => ({ useEditorTick: () => {} }));
vi.mock("./BlockTypeMenu", () => ({ BlockTypeMenu: () => <button>Text style</button> }));
vi.mock("./TableSizePicker", () => ({ TableSizePicker: () => <button>Insert table</button> }));
const toolbarWidth = vi.hoisted(() => ({ value: 900 }));
vi.mock("../../lib/use-element-width", () => ({ useElementWidth: () => ({ ref: () => {}, width: toolbarWidth.value }) }));

const { EditorToolbar } = await import("./EditorToolbar");

function fakeEditor(inTable = false) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of [
    "focus", "toggleBold", "toggleItalic", "toggleUnderline", "toggleStrike", "toggleCode",
    "toggleBulletList", "toggleOrderedList", "toggleTaskList", "toggleBlockquote", "setHorizontalRule", "insertTable",
    "undo", "redo", "addColumnBefore", "addColumnAfter", "addRowBefore", "addRowAfter",
    "toggleHeaderRow", "mergeOrSplit", "deleteRow", "deleteColumn", "deleteTable",
  ]) chain[name] = vi.fn(() => chain);
  chain.run = vi.fn();
  const editor = {
    isActive: (name: string) => inTable && name === "table",
    chain: () => chain,
    can: () => ({ undo: () => true, redo: () => true }),
    commands: { undo: vi.fn(() => true), redo: vi.fn(() => true) },
    storage: {},
  } as unknown as Editor;
  return { editor, chain };
}

let host: HTMLDivElement;
let root: Root;

async function mount(editor: Editor) {
  ({ host, root } = mountInto());
  await act(async () => root.render(<EditorToolbar editor={editor} onEditLink={() => {}} onPickFiles={() => {}} />));
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

const menuItems = () => [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].map((el) => el.textContent?.trim());

describe("EditorToolbar", () => {
  afterEach(() => {
    toolbarWidth.value = 900;
  });

  it("keeps common formatting visible and runs the rest from one More menu, without a second Quote", async () => {
    const { editor, chain } = fakeEditor();
    await mount(editor);
    expect(host.querySelector('[aria-label="Bold (⌘B)"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Task list"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Strikethrough"]')).toBeNull();

    await clickButton("More");
    expect(menuItems()).not.toContain("Quote");
    await clickMenuItem("Strikethrough");
    expect(chain.toggleStrike).toHaveBeenCalledOnce();
    expect(chain.run).toHaveBeenCalledOnce();

    await clickButton("More");
    await clickMenuItem("Divider");
    expect(chain.setHorizontalRule).toHaveBeenCalledOnce();
  });

  it("moves what does not fit a narrow toolbar into More rather than wrapping", async () => {
    toolbarWidth.value = 360;
    const { editor, chain } = fakeEditor();
    await mount(editor);
    for (const hidden of ["Underline (⌘U)", "Numbered list", "Task list", "Undo (⌘Z)"]) {
      expect(host.querySelector(`[aria-label="${hidden}"]`), hidden).toBeNull();
    }
    await clickButton("More");
    expect(menuItems()).toEqual(expect.arrayContaining(["Underline (⌘U)", "Numbered list", "Task list", "Insert table", "Undo (⌘Z)"]));
    await clickMenuItem("Task list");
    expect(chain.toggleTaskList).toHaveBeenCalledOnce();
  });

  it("groups contextual table edits in one menu", async () => {
    const { editor, chain } = fakeEditor(true);
    await mount(editor);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Insert table"))).toBe(false);

    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Table tools"))).toBe(false);
    await clickButton("Table tools");
    await clickMenuItem("Add row above");
    expect(chain.addRowBefore).toHaveBeenCalledOnce();
  });
});
