// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { mountInto } from "../test/form-input";
import { KeyboardShortcuts, openKeyboardShortcuts } from "./KeyboardShortcuts";

const listShown = () => document.querySelector("dialog[open]")?.textContent?.includes("Keyboard shortcuts") ?? false;
const press = (init: KeyboardEventInit, target: EventTarget = window) =>
  act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));

async function mount() {
  const { root } = mountInto();
  await act(async () => root.render(<KeyboardShortcuts />));
}

describe("KeyboardShortcuts", () => {
  it("opens on ? and on ⌘/ or Ctrl+/, and lists what the keys do", async () => {
    await mount();
    expect(listShown()).toBe(false);
    await press({ key: "?" });
    expect(listShown()).toBe(true);
    expect(document.querySelector("dialog[open]")?.textContent).toContain("Search documents or run a command");
    await press({ key: "/", metaKey: true });
    expect(listShown()).toBe(false);
    await press({ key: "/", ctrlKey: true });
    expect(listShown()).toBe(true);
  });

  it("leaves a ? typed into a field or the editor alone", async () => {
    await mount();
    const field = document.body.appendChild(document.createElement("input"));
    const editor = document.body.appendChild(document.createElement("div"));
    editor.contentEditable = "true";
    await press({ key: "?" }, field);
    await press({ key: "?" }, editor);
    expect(listShown()).toBe(false);
    field.remove();
    editor.remove();
  });

  it("leaves a key something else handled alone", async () => {
    await mount();
    const grid = document.body.appendChild(document.createElement("div"));
    grid.addEventListener("keydown", (e) => e.preventDefault());
    await press({ key: "/", metaKey: true }, grid);
    expect(listShown()).toBe(false);
    grid.remove();
  });

  it("opens from a menu", async () => {
    await mount();
    await act(async () => openKeyboardShortcuts());
    expect(listShown()).toBe(true);
  });
});
