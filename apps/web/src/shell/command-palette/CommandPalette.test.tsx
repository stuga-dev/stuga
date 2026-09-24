// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const folders = vi.hoisted(() => ({ create: vi.fn(), placementInstructions: vi.fn(async () => ({ inherited: [] })) }));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type: string }> }));

vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  Folders: folders,
  Docs: { search: vi.fn(async () => ({ results: [] })), create: vi.fn() },
  Me: { whoami: vi.fn(async () => ({ node_admin: false })) },
  Workspaces: { list: vi.fn(async () => ({ workspaces: [], active: null })) },
}));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type: string }) => toasts.shown.push(t),
}));

const { CommandPalette } = await import("./CommandPalette");
const { CommandPaletteProvider } = await import("./context");

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

let host: HTMLDivElement;
let root: Root;

function Where() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

const path = () => host.querySelector('[data-testid="path"]')?.textContent;

async function click(el: Element | undefined) {
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function createFolder(name: string, instructions?: string) {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
  await click([...host.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent === "New folder"));
  const input = [...host.querySelectorAll("input")].find(
    (i) => host.querySelector(`label[for="${i.id}"]`)?.textContent?.includes("Folder name"),
  );
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input!, name);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (instructions !== undefined) {
    const area = host.querySelector("textarea")!;
    const areaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      areaSetter.call(area, instructions);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Create"));
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toasts.shown = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/doc/d_1"]}>
        <CommandPaletteProvider>
          <CommandPalette />
          <Routes>
            <Route path="*" element={<Where />} />
          </Routes>
        </CommandPaletteProvider>
      </MemoryRouter>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("CommandPalette keyboard", () => {
  it("points the input at the highlighted option, so a screen reader follows the arrow keys", async () => {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const options = () => [...host.querySelectorAll('[role="listbox"] [role="option"]')];
    const active = () => host.querySelector(`[id="${input.getAttribute("aria-activedescendant")}"]`);
    expect(input.getAttribute("aria-controls")).toBe(host.querySelector('[role="listbox"]')?.id);
    expect(options().length).toBeGreaterThan(1);
    expect(active()).toBe(options()[0]);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(active()).toBe(options()[1]);
  });
});

describe("CommandPalette New folder", () => {
  it("shows the refusal and stays put when the folder cannot be created", async () => {
    folders.create.mockRejectedValue(new Error("A folder with that name exists"));
    await createFolder("Plans");
    expect(folders.create).toHaveBeenCalledWith("Plans", null, "");
    expect(toasts.shown).toContainEqual({ body: "A folder with that name exists", type: "error" });
    expect(path()).toBe("/doc/d_1");
  });

  it("goes to the library once the folder exists", async () => {
    folders.create.mockResolvedValue({ folder_id: "f_1" });
    await createFolder("Plans");
    expect(toasts.shown).toEqual([]);
    expect(path()).toBe("/");
  });

  it("creates the folder with the instructions written beside its name", async () => {
    folders.create.mockResolvedValue({ folder_id: "f_1" });
    await createFolder("Journal", "  One entry a day.  ");
    expect(folders.create).toHaveBeenCalledWith("Journal", null, "One entry a day.");
  });
});
