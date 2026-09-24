// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryRow } from "./DocTable";

const narrow = vi.hoisted(() => ({ value: false }));
vi.mock("../ui/narrow", () => ({ useIsNarrow: () => narrow.value }));
vi.mock("../state/identity", async (orig) => ({
  ...(await orig<typeof import("../state/identity")>()),
  useUserNames: () => undefined,
}));
vi.mock("../database/model/row-ref", async (orig) => ({
  ...(await orig<typeof import("../database/model/row-ref")>()),
  usePageParents: () => undefined,
}));
vi.mock("../lib/use-element-width", () => ({ useElementWidth: () => ({ ref: () => {}, width: 900 }) }));

const { DocTable } = await import("./DocTable");
type DocTableProps = Parameters<typeof DocTable>[0];

const row: LibraryRow = {
  id: "d_1",
  kind: "doc",
  title: "Plan",
  owner: "user:ada",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};
const next: LibraryRow = { ...row, id: "d_2", title: "Budget" };

let host: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();
const onSelect = vi.fn();
const onFavorite = vi.fn();
const onRename = vi.fn();

async function render(props: Partial<DocTableProps> = {}) {
  await act(async () => {
    root.render(
      <DocTable
        rows={[row, next]}
        columns={["name"]}
        selectedIds={new Set()}
        onSelectionChange={onSelect}
        onActivate={onOpen}
        sort={{ key: "updated_at", direction: "descending" }}
        onSortChange={() => {}}
        rowActions={() => []}
        {...props}
      />,
    );
  });
}

/** A row with its favorite star and its ⋯ menu. */
const renderWithControls = () =>
  render({ columns: ["name", "star", "actions"], onToggleFavorite: onFavorite, rowActions: () => [{ label: "Rename…", onClick: onRename }] });

const firstRow = () => host.querySelector<HTMLTableRowElement>("tbody tr")!;
const menuButton = () => firstRow().querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!;

async function press(el: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));
}

async function click(detail: number) {
  const target = host.querySelector("tbody tr");
  expect(target).not.toBeNull();
  await act(async () => target!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
}

const nameLink = () => host.querySelector<HTMLAnchorElement>('a[href="/doc/d_1"]')!;

/** Clicks the name as a pointer would; returns whether the browser may follow the href. */
async function clickName(init: MouseEventInit = {}) {
  let followed = true;
  await act(async () => {
    followed = nameLink().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, ...init }));
  });
  return followed;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  narrow.value = false;
  onOpen.mockReset();
  onSelect.mockReset();
  onFavorite.mockReset();
  onRename.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("document library row interaction", () => {
  it("opens a document from its name with one click without changing the row selection", async () => {
    await render();
    expect(nameLink().textContent).toBe("Plan");
    expect(await clickName()).toBe(false);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    ["Shift", { shiftKey: true }],
    ["Meta", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ] as const)("selects the row on a %s-click on the name instead of opening it", async (_, modifier) => {
    await render();
    expect(await clickName(modifier)).toBe(false);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith([row.id], row);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the name link out of the tab order, since the row is the tab stop", async () => {
    await render();
    expect(nameLink().tabIndex).toBe(-1);
    expect(host.querySelector("tbody tr")?.getAttribute("tabindex")).toBe("0");
  });

  it("does not also activate the row when the focused name receives Enter", async () => {
    await render();
    await act(async () => nameLink().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("moves the selection with the arrow keys while a clicked name has focus", async () => {
    await render();
    await act(async () => nameLink().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith([next.id], next);
  });

  it("keeps each row's star and ⋯ menu out of the tab order, so Tab leaves the table from its row", async () => {
    await renderWithControls();
    const tabbable = [...host.querySelectorAll<HTMLElement>("tbody button, tbody a, tbody [tabindex]")].filter((el) => el.tabIndex >= 0);
    expect(tabbable).toEqual([firstRow()]);
  });

  it("opens the row's ⋯ menu with Shift+F10 or the context-menu key", async () => {
    await renderWithControls();
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    await press(firstRow(), "F10", { shiftKey: true });
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    await press(document.querySelector("[role='menuitem']")!, "Escape");
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    await press(firstRow(), "ContextMenu");
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the keys pressed in an open ⋯ menu to the menu", async () => {
    await renderWithControls();
    await press(firstRow(), "F10", { shiftKey: true });
    const item = document.querySelector("[role='menuitem']")!;
    await press(item, "ArrowDown");
    await press(item, "Enter");
    await press(item, " ");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onFavorite).not.toHaveBeenCalled();
  });

  it("closes an open ⋯ menu on Escape without clearing the selection, which Escape on the row does", async () => {
    await render({ columns: ["name", "actions"], selectedIds: new Set([row.id]), rowActions: () => [{ label: "Rename…", onClick: onRename }] });
    await press(firstRow(), "F10", { shiftKey: true });
    await press(document.querySelector("[role='menuitem']")!, "Escape");
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(onSelect).not.toHaveBeenCalled();
    await press(firstRow(), "Escape");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith([], null);
  });

  it("opens with one pointer tap on a narrow screen", async () => {
    narrow.value = true;
    await render();
    await click(1);
    expect(onOpen).toHaveBeenCalledWith(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps keyboard arrow-selection behavior on a narrow screen", async () => {
    narrow.value = true;
    await render();
    await click(0);
    expect(onSelect).toHaveBeenCalledWith([row.id], row);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps desktop click-to-preview behavior", async () => {
    await render();
    await click(1);
    expect(onSelect).toHaveBeenCalledWith([row.id], row);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
