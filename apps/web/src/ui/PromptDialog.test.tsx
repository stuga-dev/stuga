// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { mountInto, typeInto } from "../test/form-input";
import { PromptDialog } from "./PromptDialog";

let host: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn();
const onClose = vi.fn();

const input = () => host.querySelector("input") as HTMLInputElement;

async function render(isOpen: boolean, initialValue = "Untitled") {
  await act(async () =>
    root.render(
      <PromptDialog isOpen={isOpen} title="Rename document" label="Title" initialValue={initialValue} submitLabel="Rename" onSubmit={onSubmit} onClose={onClose} />,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ({ host, root } = mountInto());
});

describe("PromptDialog", () => {
  it("opens with the current name selected, so typing replaces it", async () => {
    await render(true, "Untitled");
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("Untitled".length);
  });

  it("selects the new name each time it opens", async () => {
    await render(true, "Plan");
    await render(false, "Plan");
    // What opens it next, as a row's menu does; jsdom does not blur a field in a closed dialog.
    const trigger = host.appendChild(document.createElement("button"));
    trigger.focus();
    await render(true, "Bakery handbook");
    expect(input().value).toBe("Bakery handbook");
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("Bakery handbook".length);
  });

  it("submits the trimmed value and closes", async () => {
    await render(true, "Plan");
    await typeInto(input(), "  Launch plan ");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Rename")!.click());
    expect(onSubmit).toHaveBeenCalledWith("Launch plan");
    expect(onClose).toHaveBeenCalled();
  });
});
