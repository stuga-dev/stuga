// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { OtherNode } from "../api";
import { toasts } from "../test/toast";
import { mountInto, typeInto } from "../test/form-input";

const otherNodes = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn(), onChanged: vi.fn() }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  OtherNodes: otherNodes,
}));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

const { OtherNodesDialog } = await import("./OtherNodesDialog");

const STUDIO: OtherNode = { id: "nb_1", label: "Studio", origin: "https://studio.example" };
const NAS: OtherNode = { id: "nb_2", label: "nas.local:8787", origin: "http://nas.local:8787" };

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);

function input(labelText: string): HTMLInputElement {
  const found = [...host.querySelectorAll("input")].find((i) =>
    (host.querySelector(`label[for="${i.id}"]`)?.textContent ?? "").startsWith(labelText),
  );
  expect(found, `no input labelled ${labelText}`).toBeTruthy();
  return found!;
}

const type = (labelText: string, value: string) => typeInto(input(labelText), value);

async function click(label: string) {
  const el = button(label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function render(nodes: OtherNode[]) {
  await act(async () => root.render(<OtherNodesDialog isOpen nodes={nodes} onClose={onClose} />));
}

/** A refusal as the API client throws it. */
function refused(code: string): Error {
  return Object.assign(new Error(code), { status: code === "already_added" || code === "limit_reached" ? 409 : 400, code });
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.shown = [];
  otherNodes.add.mockResolvedValue({ node: STUDIO });
  otherNodes.remove.mockResolvedValue(undefined);
  ({ host, root } = mountInto());
});

describe("OtherNodesDialog", () => {
  it("lists each bookmark with its origin and a way to remove it", async () => {
    await render([STUDIO, NAS]);
    expect(host.textContent).toContain("Studio");
    expect(host.textContent).toContain("https://studio.example");
    await click("Remove nas.local:8787");
    expect(otherNodes.remove).toHaveBeenCalledWith("nb_2");
  });

  it("adds what was typed, trimmed, and clears the form for the next one", async () => {
    await render([]);
    expect(button("Add")!.disabled).toBe(true);
    await type("Label", "  Studio ");
    await type("URL", " https://studio.example/doc/1 ");
    await click("Add");
    expect(otherNodes.add).toHaveBeenCalledWith("https://studio.example/doc/1", "Studio");
    expect(input("Label").value).toBe("");
    expect(input("URL").value).toBe("");
  });

  it("says under the URL why it was refused, keeps what was typed, and lets go once it is edited", async () => {
    await render([STUDIO]);
    for (const [code, says] of [
      ["already_added", "already in your list"],
      ["own_node", "this node’s own address"],
      ["invalid_url", "starting with https:// or http://"],
      ["limit_reached", "Remove one first"],
    ] as const) {
      otherNodes.add.mockRejectedValueOnce(refused(code));
      await type("URL", "https://studio.example");
      await click("Add");
      expect(host.textContent).toContain(says);
      expect(input("URL").value).toBe("https://studio.example");
    }
    await type("URL", "https://studio.example/");
    expect(host.textContent).not.toContain("Remove one first");
  });

  it("puts a label the node refused under the label", async () => {
    await render([]);
    otherNodes.add.mockRejectedValueOnce(refused("invalid_label"));
    await type("Label", "Studio");
    await type("URL", "https://studio.example");
    await click("Add");
    expect(host.textContent).toContain("Use up to 80 characters, at least one of them visible");
  });

  it("says as it is typed why a label would be refused, and sends nothing until it is fixed", async () => {
    await render([]);
    await type("URL", "https://studio.example");
    for (const [label, says] of [
      ["\u200b\u200b", "Use at least one visible character."],
      ["Stu\u2028dio", "Remove the hidden control characters."],
      ["x".repeat(81), "Use up to 80 characters."],
    ] as const) {
      await type("Label", label);
      expect(host.textContent).toContain(says);
      expect(button("Add")!.disabled).toBe(true);
      await act(async () => input("Label").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    }
    expect(otherNodes.add).not.toHaveBeenCalled();

    // Emptied, the node names it after the host.
    await type("Label", "  ");
    expect(button("Add")!.disabled).toBe(false);
    await click("Add");
    expect(otherNodes.add).toHaveBeenCalledWith("https://studio.example", "");
  });

  it("toasts a removal that failed", async () => {
    otherNodes.remove.mockRejectedValueOnce(new Error("The server isn’t responding right now."));
    await render([STUDIO]);
    await click("Remove Studio");
    expect(toasts.shown).toEqual([{ body: "The server isn’t responding right now.", type: "error" }]);
  });
});
