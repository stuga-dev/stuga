// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
const folders = vi.hoisted(() => ({
  placementInstructions: vi.fn(async (): Promise<{ inherited: Array<{ kind: string; id: string; title: string; text: string }> }> => ({
    inherited: [],
  })),
}));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Folders: folders }));

const { NewFolderDialog } = await import("./NewFolderDialog");

let host: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn();
const onClose = vi.fn();

const input = () => host.querySelector("input") as HTMLInputElement;
const textarea = () => host.querySelector("textarea") as HTMLTextAreaElement;
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open() {
  await act(async () => root.render(<NewFolderDialog isOpen onSubmit={onSubmit} onClose={onClose} />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no dialog methods, and Astryx Dialog calls them.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("NewFolderDialog", () => {
  it("shows what a folder made here would already inherit, and says the box only adds to it", async () => {
    folders.placementInstructions.mockResolvedValue({
      inherited: [
        { kind: "workspace", id: "ws1", title: "Acme", text: "Write in British English." },
        { kind: "folder", id: "f_1", title: "Journal", text: "One entry a day." },
      ],
    });
    await act(async () => root.render(<NewFolderDialog isOpen parentId="f_1" onSubmit={onSubmit} onClose={onClose} />));
    expect(folders.placementInstructions).toHaveBeenCalledWith("f_1");
    const text = host.textContent ?? "";
    const order = ['Workspace "Acme"', "Write in British English.", 'Folder "Journal"', "One entry a day."].map((t) => text.indexOf(t));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("What this folder adds");
  });

  it("asks for the top level's stack when there is no parent", async () => {
    folders.placementInstructions.mockResolvedValue({ inherited: [] });
    await open();
    expect(folders.placementInstructions).toHaveBeenCalledWith(null);
    expect(host.textContent).toContain("What agents working in this folder should follow");
  });

  it("creates the folder with the instructions, both trimmed", async () => {
    await open();
    await type(input(), "  Journal  ");
    await type(textarea(), "  One entry a day.  ");
    await act(async () => button("Create")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSubmit).toHaveBeenCalledWith("Journal", "One entry a day.");
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves the instructions empty when nobody wrote any", async () => {
    await open();
    await type(input(), "Journal");
    await act(async () => button("Create")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSubmit).toHaveBeenCalledWith("Journal", "");
  });

  it("keeps Create off without a name, and past the instruction cap", async () => {
    await open();
    expect(button("Create")!.disabled).toBe(true);
    await type(input(), "Journal");
    expect(button("Create")!.disabled).toBe(false);
    await type(textarea(), "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1));
    expect(button("Create")!.disabled).toBe(true);
    expect(host.textContent).toContain("Too long");
    await act(async () => button("Create")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("starts empty on the next opening, so one folder's instructions never seed another", async () => {
    await open();
    await type(input(), "Journal");
    await type(textarea(), "One entry a day.");
    await act(async () => root.render(<NewFolderDialog isOpen={false} onSubmit={onSubmit} onClose={onClose} />));
    await open();
    expect(input().value).toBe("");
    expect(textarea().value).toBe("");
  });
});
