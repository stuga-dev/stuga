// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { DATABASE_MAX_COLUMN_DESCRIPTION_CHARS } from "@stuga/protocol/databases/limits";
import type { ColumnSpec } from "@stuga/protocol/databases/types";
import { ColumnDialog, type ColumnDialogSubmit } from "./ColumnDialog";
import { mountInto } from "../test/form-input";

const NOTES: ColumnSpec = {
  column_id: "c1",
  name: "notes",
  display: "Notes",
  type: "text",
  position: 0,
  options: null,
  description: "What the guest asked for.",
};

let host: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn<(spec: ColumnDialogSubmit) => void>();
const onClose = vi.fn();

const nameInput = () => host.querySelector("input") as HTMLInputElement;
const descriptionInput = () => host.querySelector("textarea") as HTMLTextAreaElement | null;
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

async function open(retypeOf: ColumnSpec | null = null) {
  await act(async () =>
    root.render(<ColumnDialog isOpen retypeOf={retypeOf} busy={false} onSubmit={onSubmit} onClose={onClose} />),
  );
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  const el = button(label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  vi.clearAllMocks();
  ({ host, root } = mountInto());
});

describe("ColumnDialog", () => {
  it("sends the trimmed description with a new column", async () => {
    await open();
    expect(host.textContent).toContain("Shown in the header and used by AI answers.");
    await type(nameInput(), "Notes");
    await type(descriptionInput()!, "  What the guest asked for.\n");
    await click("Add column");
    expect(onSubmit).toHaveBeenCalledWith({
      display: "Notes",
      type: "text",
      choices: undefined,
      description: "What the guest asked for.",
    });
  });

  it("leaves the description out when nothing was written", async () => {
    await open();
    await type(nameInput(), "Notes");
    await click("Add column");
    expect(onSubmit).toHaveBeenCalledWith({ display: "Notes", type: "text", choices: undefined, description: undefined });
  });

  it("refuses a description past the cap here rather than waiting for the server", async () => {
    await open();
    await type(nameInput(), "Notes");
    await type(descriptionInput()!, "x".repeat(DATABASE_MAX_COLUMN_DESCRIPTION_CHARS + 1));
    expect(button("Add column")!.disabled).toBe(true);
    expect(host.textContent).toContain("Too long");
    await type(descriptionInput()!, "x".repeat(DATABASE_MAX_COLUMN_DESCRIPTION_CHARS));
    expect(button("Add column")!.disabled).toBe(false);
  });

  it("starts every opening from an empty description", async () => {
    await open();
    await type(descriptionInput()!, "Left behind.");
    await act(async () =>
      root.render(<ColumnDialog isOpen={false} retypeOf={null} busy={false} onSubmit={onSubmit} onClose={onClose} />),
    );
    await open();
    expect(descriptionInput()!.value).toBe("");
  });

  it("keeps a retype about the type: no description field, and none is sent", async () => {
    await open(NOTES);
    expect(host.textContent).toContain("Change type of");
    expect(descriptionInput()).toBeNull();
    await click("Change type");
    expect(onSubmit).toHaveBeenCalledWith({ display: "Notes", type: "text", choices: undefined, description: undefined });
  });
});
