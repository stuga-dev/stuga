// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import type { ItemInstructions } from "../api";
import type { InstructionsTarget } from "./InstructionsDialog";

const docs = vi.hoisted(() => ({ instructions: vi.fn(), setState: vi.fn() }));
const folders = vi.hoisted(() => ({ instructions: vi.fn(), setInstructions: vi.fn() }));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type: string }> }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Docs: docs,
  Folders: folders,
}));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type: string }) => toasts.shown.push(t),
}));

const { InstructionsDialog } = await import("./InstructionsDialog");

// jsdom's <dialog> has no showModal/close, which Astryx Dialog calls.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

const WORKSPACE: InstructionLevel = { kind: "workspace", id: "w_1", title: "Acme", text: "Write in British English." };
const CONTRACTS: InstructionLevel = { kind: "folder", id: "f_1", title: "Contracts", text: "Never change signed terms.\nAsk first." };
const FOLDER: InstructionsTarget = { kind: "folder", id: "f_2", title: "Drafts" };
const DOCUMENT: InstructionsTarget = { kind: "document", id: "d_1", title: "Q3 plan" };

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

const textarea = () => host.querySelector("textarea") as HTMLTextAreaElement;
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

async function open(target: InstructionsTarget, answer: ItemInstructions) {
  (target.kind === "folder" ? folders : docs).instructions.mockResolvedValue(answer);
  await act(async () => root.render(<InstructionsDialog isOpen target={target} onClose={onClose} />));
}

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  const el = button(label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toasts.shown = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("InstructionsDialog", () => {
  it("shows the inherited levels outermost first, each under its label, then the item's own text", async () => {
    await open(DOCUMENT, { own: "Keep the summary short.", inherited: [WORKSPACE, CONTRACTS], can_edit: true });
    expect(docs.instructions).toHaveBeenCalledWith(DOCUMENT.id);
    const text = host.textContent ?? "";
    const order = ['Workspace "Acme"', WORKSPACE.text, 'Folder "Contracts"', "Never change signed terms."].map((s) => text.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("Ask first.");
    expect(textarea().value).toBe("Keep the summary short.");
    expect(textarea().disabled).toBe(false);
    expect(textarea().readOnly).toBe(false);
  });

  it("says nothing is inherited when no level above has text", async () => {
    await open(FOLDER, { own: "", inherited: [], can_edit: true });
    expect(folders.instructions).toHaveBeenCalledWith(FOLDER.id);
    expect(host.textContent).toContain("Nothing is inherited from above.");
  });

  it("says a folder's instructions reach only people who can open it, and says nothing of the kind for a document", async () => {
    await open(FOLDER, { own: "", inherited: [], can_edit: true });
    expect(host.textContent).toContain("Only people with access to this folder receive them.");
    await act(async () => root.render(<InstructionsDialog isOpen={false} target={FOLDER} onClose={onClose} />));
    await open(DOCUMENT, { own: "", inherited: [], can_edit: true });
    expect(host.textContent).not.toContain("Only people with access");
  });

  it("shows a failed load in the dialog", async () => {
    docs.instructions.mockRejectedValue(new Error("That isn’t here any more."));
    await act(async () => root.render(<InstructionsDialog isOpen target={DOCUMENT} onClose={onClose} />));
    expect(host.textContent).toContain("Couldn’t load the instructions");
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("lets a reader look but not change anything", async () => {
    await open(DOCUMENT, { own: "Keep the summary short.", inherited: [WORKSPACE], can_edit: false });
    // Read-only, not disabled: a reader can still focus, scroll and copy long text.
    expect(textarea().readOnly).toBe(true);
    expect(textarea().disabled).toBe(false);
    expect(host.textContent).toContain("Only the owner or a workspace admin can change them.");
    expect(button("Save")).toBeUndefined();
  });

  it("keeps Save off until the text changes, and off again past the limit", async () => {
    await open(FOLDER, { own: "Old", inherited: [], can_edit: true });
    expect(button("Save")!.disabled).toBe(true);
    await type("New");
    expect(button("Save")!.disabled).toBe(false);
    await type("x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1));
    expect(button("Save")!.disabled).toBe(true);
    expect(host.textContent).toContain("Too long");
  });

  it("warns when the whole stack is longer than agents read", async () => {
    const full = (id: string): InstructionLevel => ({ kind: "folder", id, title: id, text: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS) });
    await open(DOCUMENT, { own: "", inherited: [full("a"), full("b"), full("c")], can_edit: true });
    expect(host.textContent).not.toContain("truncate the nearest instructions");
    // Surrounding whitespace is trimmed before agents read it, so it does not count.
    await type("  \n");
    expect(host.textContent).not.toContain("truncate the nearest instructions");
    await type("y");
    expect(host.textContent).toContain("truncate the nearest instructions");
    expect(button("Save")!.disabled).toBe(false);
  });

  it("saves a folder's text through the folder route and closes", async () => {
    folders.setInstructions.mockResolvedValue({});
    await open(FOLDER, { own: "", inherited: [], can_edit: true });
    await type("  Drafts are never final.\n");
    await click("Save");
    expect(folders.setInstructions).toHaveBeenCalledWith(FOLDER.id, "  Drafts are never final.\n");
    expect(docs.setState).not.toHaveBeenCalled();
    expect(toasts.shown).toContainEqual({ body: "Instructions saved. Agents read them on their next turn.", type: "info" });
    expect(onClose).toHaveBeenCalled();
  });

  it("saves a document's or database's text through its state", async () => {
    docs.setState.mockResolvedValue({});
    await open({ kind: "database", id: "db_1", title: "Tasks" }, { own: "", inherited: [], can_edit: true });
    await type("One row per task.");
    await click("Save");
    expect(docs.setState).toHaveBeenCalledWith("db_1", { agent_instructions: "One row per task." });
    expect(folders.setInstructions).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("cannot be closed while a save is in flight, so a late answer never lands on the next opening", async () => {
    let finish: (value: unknown) => void = () => {};
    folders.setInstructions.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await open(FOLDER, { own: "", inherited: [], can_edit: true });
    await type("Drafts are never final.");
    await click("Save");
    expect(button("Cancel")!.disabled).toBe(true);
    // Escape reaches an Astryx dialog as the native cancel event.
    await act(async () => host.ownerDocument.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({}));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape when nothing is saving", async () => {
    await open(FOLDER, { own: "", inherited: [], can_edit: true });
    await act(async () => host.ownerDocument.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says who may change them on a refusal, and stays open", async () => {
    docs.setState.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    await open(DOCUMENT, { own: "", inherited: [], can_edit: true });
    await type("Be brief.");
    await click("Save");
    expect(toasts.shown).toContainEqual({ body: "Only the owner or a workspace admin can change these instructions.", type: "error" });
    expect(onClose).not.toHaveBeenCalled();
    expect(textarea().value).toBe("Be brief.");
  });

  it("asks for a retry on any other failure", async () => {
    docs.setState.mockRejectedValue(Object.assign(new Error("Server error"), { status: 500 }));
    await open(DOCUMENT, { own: "", inherited: [], can_edit: true });
    await type("Be brief.");
    await click("Save");
    expect(toasts.shown).toContainEqual({ body: "Couldn’t save the instructions. Please try again.", type: "error" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
