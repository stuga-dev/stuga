// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { mountInto, typeInto } from "../test/form-input";
import { NewFolderDialog } from "./NewFolderDialog";

let host: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn();
const onClose = vi.fn();

const input = () => host.querySelector("input") as HTMLInputElement;
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

async function render(isOpen: boolean) {
  await act(async () => root.render(<NewFolderDialog isOpen={isOpen} onSubmit={onSubmit} onClose={onClose} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  ({ host, root } = mountInto());
});

describe("NewFolderDialog", () => {
  it("asks only for a name", async () => {
    await render(true);
    expect(host.querySelectorAll("input, textarea")).toHaveLength(1);
    expect(host.textContent).not.toContain("agents");
  });

  it("creates the folder with the trimmed name and closes", async () => {
    await render(true);
    await typeInto(input(), "  Journal  ");
    await act(async () => button("Create")!.click());
    expect(onSubmit).toHaveBeenCalledWith("Journal");
    expect(onClose).toHaveBeenCalled();
  });

  it("creates nothing without a name", async () => {
    await render(true);
    await act(async () => button("Create")!.click());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("starts empty on the next opening", async () => {
    await render(true);
    await typeInto(input(), "Journal");
    await render(false);
    await render(true);
    expect(input().value).toBe("");
  });
});
