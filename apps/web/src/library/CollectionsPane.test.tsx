// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { CollectionSummary } from "../api";
import { toasts } from "../test/toast";
import { mountInto, typeInto } from "../test/form-input";

const collections = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn() }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Collections: collections,
}));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
vi.mock("./CollectionEditor", () => ({ CollectionEditor: () => null }));
// The row menu stands in as its items' buttons.
vi.mock("@astryxdesign/core/MoreMenu", () => ({
  MoreMenu: ({ items }: { items: Array<{ label: string; onClick: () => void }> }) => (
    <>
      {items.map((item) => (
        <button key={item.label} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </>
  ),
}));

const { CollectionsPane } = await import("./CollectionsPane");

const LAUNCH: CollectionSummary = { collection_id: "c_1", name: "Launch", item_count: 0, updated_at: "2026-09-01T00:00:00.000Z" };

let root: Root;
const onSelect = vi.fn();

const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);

async function click(label: string) {
  const el = button(label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function type(labelText: string, value: string) {
  // Both name prompts stay in the DOM; only the open one takes input.
  const input = [...document.body.querySelectorAll("dialog[open] input")].find(
    (i) => (document.body.querySelector(`label[for="${i.id}"]`)?.textContent ?? "").includes(labelText),
  ) as HTMLInputElement | undefined;
  expect(input, `no input labelled ${labelText}`).toBeTruthy();
  await typeInto(input, value);
}

beforeEach(async () => {
  vi.clearAllMocks();
  toasts.shown = [];
  collections.list.mockResolvedValue({ collections: [LAUNCH] });
  collections.get.mockResolvedValue({ collection: LAUNCH, items: [] });
  ({ root } = mountInto());
  await act(async () => root.render(<CollectionsPane selectedId={LAUNCH.collection_id} onSelect={onSelect} />));
});

describe("CollectionsPane", () => {
  it("offers no New collection to a guest, who cannot make one", async () => {
    collections.list.mockResolvedValue({ collections: [] });
    await act(async () => root.render(<CollectionsPane selectedId={null} onSelect={onSelect} canCreate={false} />));
    expect(button("New collection")).toBeUndefined();
  });

  it("shows the refusal when a collection cannot be created, and selects nothing", async () => {
    collections.create.mockRejectedValue(new Error("A collection with that name exists"));
    await click("New collection");
    await type("Collection name", "Launch");
    await click("Create");
    expect(collections.create).toHaveBeenCalledWith("Launch");
    expect(toasts.shown).toContainEqual({ body: "A collection with that name exists", type: "error" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects a collection once it is created", async () => {
    collections.create.mockResolvedValue({ ...LAUNCH, collection_id: "c_2", name: "Research" });
    await click("New collection");
    await type("Collection name", "Research");
    await click("Create");
    expect(toasts.shown).toEqual([]);
    expect(onSelect).toHaveBeenCalledWith("c_2");
  });

  it("shows the refusal when a rename fails", async () => {
    collections.rename.mockRejectedValue(new Error("You can’t rename this collection"));
    await click("Rename…");
    await type("Collection name", "Launch plan");
    await click("Rename");
    expect(collections.rename).toHaveBeenCalledWith(LAUNCH.collection_id, "Launch plan");
    expect(toasts.shown).toContainEqual({ body: "You can’t rename this collection", type: "error" });
  });

  it("shows the refusal and keeps the selection when a delete fails", async () => {
    collections.remove.mockRejectedValue(new Error("You can’t delete this collection"));
    await click("Delete…");
    await click("Delete");
    expect(collections.remove).toHaveBeenCalledWith(LAUNCH.collection_id);
    expect(toasts.shown).toContainEqual({ body: "You can’t delete this collection", type: "error" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clears the selection once the selected collection is deleted", async () => {
    collections.remove.mockResolvedValue({ deleted: true });
    await click("Delete…");
    await click("Delete");
    expect(toasts.shown).toEqual([]);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
