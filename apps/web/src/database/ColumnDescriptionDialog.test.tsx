// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DATABASE_MAX_COLUMN_DESCRIPTION_CHARS } from "@stuga/protocol/databases/limits";
import type { ColumnSpec } from "@stuga/protocol/databases/types";

const databases = vi.hoisted(() => ({ setColumnDescription: vi.fn() }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Databases: databases,
}));

const { ColumnDescriptionDialog } = await import("./ColumnDescriptionDialog");

// jsdom's <dialog> has no showModal/close, which Astryx Dialog calls.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

const column = (over: Partial<ColumnSpec> = {}): ColumnSpec => ({
  column_id: "c1",
  name: "nightly_rate",
  display: "Nightly Rate",
  type: "number",
  position: 0,
  options: null,
  description: "What one night costs, before tax.",
  ...over,
});

let host: HTMLDivElement;
let root: Root;
const onSaved = vi.fn();
const onError = vi.fn<(e: unknown, fallback: string) => void>();
const onClose = vi.fn();

const textarea = () => host.querySelector("textarea") as HTMLTextAreaElement;
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

async function render(isOpen: boolean, col: ColumnSpec | null) {
  await act(async () =>
    root.render(
      <ColumnDescriptionDialog
        isOpen={isOpen}
        docId="d_1"
        tableId="t_1"
        column={col}
        onSaved={onSaved}
        onError={onError}
        onClose={onClose}
      />,
    ),
  );
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
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("ColumnDescriptionDialog", () => {
  it("seeds from the column and saves the trimmed text through the column route", async () => {
    databases.setColumnDescription.mockResolvedValue({ column: column() });
    await render(true, column());
    expect(host.textContent).toContain("Nightly Rate");
    expect(textarea().value).toBe("What one night costs, before tax.");
    await type("  What one night costs, tax included.\n");
    await click("Save");
    expect(databases.setColumnDescription).toHaveBeenCalledWith("d_1", "t_1", "c1", "What one night costs, tax included.");
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("clears the description with an empty field", async () => {
    databases.setColumnDescription.mockResolvedValue({ column: column({ description: undefined }) });
    await render(true, column());
    await type("   ");
    await click("Save");
    expect(databases.setColumnDescription).toHaveBeenCalledWith("d_1", "t_1", "c1", "");
  });

  it("keeps Save off while the text is unchanged", async () => {
    await render(true, column());
    expect(button("Save")!.disabled).toBe(true);
    // Whitespace around the same text is not a change: the server stores it trimmed.
    await type("  What one night costs, before tax.  ");
    expect(button("Save")!.disabled).toBe(true);
    await type("Rate per night.");
    expect(button("Save")!.disabled).toBe(false);
  });

  it("refuses text past the cap here rather than waiting for the 400", async () => {
    await render(true, column());
    await type("x".repeat(DATABASE_MAX_COLUMN_DESCRIPTION_CHARS + 1));
    expect(button("Save")!.disabled).toBe(true);
    expect(host.textContent).toContain("Too long");
    expect(host.textContent).toContain(String(DATABASE_MAX_COLUMN_DESCRIPTION_CHARS));
    await type("x".repeat(DATABASE_MAX_COLUMN_DESCRIPTION_CHARS));
    expect(button("Save")!.disabled).toBe(false);
    expect(databases.setColumnDescription).not.toHaveBeenCalled();
  });

  it("surfaces a refusal through the grid's handler and stays open with the text kept", async () => {
    const refusal = Object.assign(new Error("Forbidden"), { status: 403 });
    databases.setColumnDescription.mockRejectedValue(refusal);
    await render(true, column());
    await type("Agents may not write this.");
    await click("Save");
    expect(onError).toHaveBeenCalledWith(refusal, "Couldn’t save the description.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(textarea().value).toBe("Agents may not write this.");
    expect(button("Save")!.disabled).toBe(false);
  });

  it("re-seeds on the next opening, since the dialog stays mounted", async () => {
    await render(true, column());
    await type("Half-written.");
    await render(false, null);
    await render(true, column({ column_id: "c2", display: "Breakfast", description: "Included, or paid on the day." }));
    expect(textarea().value).toBe("Included, or paid on the day.");
    expect(host.textContent).toContain("Breakfast");
  });

  it("starts empty for a column that has no description yet", async () => {
    await render(true, column({ description: undefined }));
    expect(textarea().value).toBe("");
    expect(button("Save")!.disabled).toBe(true);
  });

  it("cannot be closed while a save is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    databases.setColumnDescription.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await render(true, column());
    await type("Rate per night.");
    await click("Save");
    expect(button("Cancel")!.disabled).toBe(true);
    // Escape reaches an Astryx dialog as the native cancel event.
    await act(async () => host.ownerDocument.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({ column: column() }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
