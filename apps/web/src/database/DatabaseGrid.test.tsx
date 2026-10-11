// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { RowRecord, TableSchema } from "@stuga/protocol/databases/types";
import { DATABASE_ROW_SEARCH_MAX_CHARS } from "@stuga/protocol/databases/limits";
import { toasts } from "../test/toast";
import { mountInto, typeInto } from "../test/form-input";

const databases = vi.hoisted(() => ({ listRows: vi.fn(), updateRows: vi.fn(), insertRows: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Databases: databases }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
vi.mock("../review/db-runs-context", () => ({ useDbRuns: () => ({ pending: [], inFlight: new Set(), decide: vi.fn() }) }));
// The view bar measures itself; jsdom has no layout to observe.
vi.mock("../lib/use-element-width", () => ({ useElementWidth: () => ({ ref: () => {}, width: 1000 }) }));

const { DatabaseGrid } = await import("./DatabaseGrid");
import type { GridListing } from "./DatabaseGrid";

const TABLE: TableSchema = {
  table_id: "t1",
  name: "items",
  display: "Items",
  position: 0,
  row_count: 2,
  columns: [
    { column_id: "c_name", name: "name", display: "Name", type: "text", position: 0, options: null },
    { column_id: "c_notes", name: "notes", display: "Notes", type: "text", position: 1, options: null },
    { column_id: "c_qty", name: "qty", display: "Qty", type: "number", position: 2, options: null },
  ],
  views: [],
};

const row = (id: string, cells: Record<string, string | number | null>): RowRecord => ({ _id: id, _created_at: 0, _updated_at: 0, ...cells }) as RowRecord;

let host: HTMLDivElement;
let root: Root;
const onSchemaChange = vi.fn();

async function render(rows: RowRecord[], onListing?: (listing: GridListing) => void) {
  databases.listRows.mockResolvedValue({ rows, total: rows.length });
  await act(async () =>
    root.render(
      <DatabaseGrid
        docId="db1"
        table={TABLE}
        readOnly={false}
        rowsKey={0}
        onSchemaChange={onSchemaChange}
        onWriteDenied={() => {}}
        onRowsMutated={() => {}}
        activeViewId={null}
        onSelectView={() => {}}
        onOpenRow={() => {}}
        openRowId={null}
        onListing={onListing}
      />,
    ),
  );
}

const cell = (rowId: string, columnId: string) => host.querySelector<HTMLElement>(`tr[data-row="${rowId}"] > td[data-col="${columnId}"]`)!;
const cellButton = (rowId: string, columnId: string) => cell(rowId, columnId).querySelector<HTMLButtonElement>("button.db-cell")!;
const editor = () => host.querySelector<HTMLInputElement>(".db-cell-input");

async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));
}

function pasteEvent(text: string): Event {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: { getData: () => text } });
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.shown = [];
  databases.updateRows.mockResolvedValue({ updated: 1, missing: [] });
  databases.insertRows.mockResolvedValue({ inserted: 1, row_ids: ["r9"] });
  ({ host, root } = mountInto());
});

describe("typing on a cell", () => {
  it("starts the edit with the typed character and keeps every one after it", async () => {
    await render([row("r1", { c_name: "Sourdough", c_notes: null, c_qty: null })]);
    cellButton("r1", "c_notes").focus();
    await key(cellButton("r1", "c_notes"), "F");
    expect(editor()?.value).toBe("F");
    await typeInto(editor(), "Fresh daily");
    await key(editor()!, "Enter");
    expect(databases.updateRows).toHaveBeenCalledWith("db1", "t1", [{ _id: "r1", values: { c_notes: "Fresh daily" }, expect: { c_notes: null } }]);
    // Focus comes back to the grid, on the cell itself as there is no row below.
    expect(document.activeElement).toBe(cellButton("r1", "c_notes"));
  });

  it("opens a number cell only on a character that can start a number", async () => {
    await render([row("r1", { c_name: "a", c_notes: null, c_qty: null })]);
    await key(cellButton("r1", "c_qty"), "x");
    expect(editor()).toBeNull();
    await key(cellButton("r1", "c_qty"), "4");
    expect(editor()?.value).toBe("4");
    expect(editor()?.type).toBe("text");
    expect(editor()?.inputMode).toBe("decimal");
  });

  it("refuses junk in a number cell and keeps the editor open, under one toast", async () => {
    await render([row("r1", { c_name: "a", c_notes: null, c_qty: 2 })]);
    await act(async () => cellButton("r1", "c_qty").click());
    await typeInto(editor(), "1.2.3");
    await key(editor()!, "Enter");
    await key(editor()!, "Enter");
    expect(editor()).not.toBeNull();
    expect(databases.updateRows).not.toHaveBeenCalled();
    // Raised twice under one id, which the toast stack shows as one.
    expect(toasts.shown).toEqual([
      expect.objectContaining({ body: "Enter a number.", uniqueID: "db-cell-problem" }),
      expect.objectContaining({ body: "Enter a number.", uniqueID: "db-cell-problem" }),
    ]);
  });

  it("drops a refused value when the editor loses focus, rather than staying open", async () => {
    await render([row("r1", { c_name: "a", c_notes: null, c_qty: 2 })]);
    await act(async () => cellButton("r1", "c_qty").click());
    await typeInto(editor(), "abc");
    await act(async () => editor()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(editor()).toBeNull();
    expect(databases.updateRows).not.toHaveBeenCalled();
  });
});

describe("moving with the keyboard", () => {
  it("walks cells with the arrows, edits with F2, clears with Delete and goes down after Enter", async () => {
    await render([row("r1", { c_name: "a", c_notes: "x", c_qty: 1 }), row("r2", { c_name: "b", c_notes: "y", c_qty: 2 })]);
    cellButton("r1", "c_name").focus();
    await key(cellButton("r1", "c_name"), "ArrowRight");
    expect(document.activeElement).toBe(cellButton("r1", "c_notes"));
    await key(cellButton("r1", "c_notes"), "ArrowDown");
    expect(document.activeElement).toBe(cellButton("r2", "c_notes"));
    await key(cellButton("r2", "c_notes"), "ArrowDown");
    expect(document.activeElement).toBe(cellButton("r2", "c_notes"));

    await key(cellButton("r2", "c_notes"), "Delete");
    expect(databases.updateRows).toHaveBeenLastCalledWith("db1", "t1", [{ _id: "r2", values: { c_notes: null }, expect: { c_notes: "y" } }]);

    await key(cellButton("r1", "c_name"), "F2");
    expect(editor()?.value).toBe("a");
    await key(editor()!, "Escape");
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(cellButton("r1", "c_name"));

    await act(async () => cellButton("r1", "c_name").click());
    await typeInto(editor(), "a2");
    await key(editor()!, "Enter");
    expect(document.activeElement).toBe(cellButton("r2", "c_name"));
  });
});

describe("someone else's edit", () => {
  it("is not overwritten unseen: the cell shows theirs and the person can keep their own", async () => {
    databases.updateRows.mockResolvedValueOnce({ updated: 0, missing: [], conflicts: [{ _id: "r1", values: { c_notes: "Omar says 7 kg" } }] });
    await render([row("r1", { c_name: "Sugar", c_notes: "start", c_qty: null })]);
    await act(async () => cellButton("r1", "c_notes").click());
    await typeInto(editor(), "Liv says 5 kg");
    await key(editor()!, "Enter");
    expect(cellButton("r1", "c_notes").textContent).toBe("Omar says 7 kg");
    const shown = toasts.shown.at(-1) as unknown as { body: string; endContent: { props: { onClick: () => void } } };
    expect(shown.body).toBe("Someone else changed this cell while you were editing. It now says “Omar says 7 kg”.");
    await act(async () => shown.endContent.props.onClick());
    expect(databases.updateRows).toHaveBeenLastCalledWith("db1", "t1", [
      { _id: "r1", values: { c_notes: "Liv says 5 kg" }, expect: { c_notes: "Omar says 7 kg" } },
    ]);
  });

  it("deleting the column says so in plain words, with the typed text", async () => {
    const gone = Object.assign(new Error("That column no longer exists."), { status: 400, code: 'unknown column reference "c_notes"' });
    databases.updateRows.mockRejectedValueOnce(gone);
    await render([row("r1", { c_name: "Sugar", c_notes: null, c_qty: null })]);
    await act(async () => cellButton("r1", "c_notes").click());
    await typeInto(editor(), "half a bag");
    await key(editor()!, "Enter");
    expect(toasts.shown.at(-1)?.body).toBe("This column was deleted while you were editing. What you typed: “half a bag”");
    expect(onSchemaChange).toHaveBeenCalled();
  });
});

describe("pasting", () => {
  it("fills a block right and down from a cell and adds the rows it runs past", async () => {
    await render([row("r1", { c_name: "a", c_notes: null, c_qty: null })]);
    await act(async () => cellButton("r1", "c_notes").dispatchEvent(pasteEvent("Matcha cake\t4,50\r\nChocolate tart\t3\r\n")));
    expect(databases.updateRows).toHaveBeenCalledWith("db1", "t1", [{ _id: "r1", values: { c_notes: "Matcha cake", c_qty: 4.5 } }]);
    expect(databases.insertRows).toHaveBeenCalledWith("db1", "t1", [{ c_notes: "Chocolate tart", c_qty: 3 }]);
    expect(toasts.shown.at(-1)?.body).toBe("Pasted 2 rows × 2 columns.");
  });

  it("turns a range pasted into an editor into cells instead of one string", async () => {
    await render([row("r1", { c_name: "a", c_notes: null, c_qty: null }), row("r2", { c_name: "b", c_notes: null, c_qty: null })]);
    await act(async () => cellButton("r1", "c_name").click());
    await act(async () => editor()!.dispatchEvent(pasteEvent("x\tMatcha\ny\tTart")));
    expect(editor()).toBeNull();
    expect(databases.updateRows).toHaveBeenCalledWith("db1", "t1", [
      { _id: "r1", values: { c_name: "x", c_notes: "Matcha" } },
      { _id: "r2", values: { c_name: "y", c_notes: "Tart" } },
    ]);
  });

  it("keeps lines pasted into an editor in that cell, and leaves the rows below alone", async () => {
    await render([row("r1", { c_name: "a", c_notes: null, c_qty: null }), row("r2", { c_name: "b", c_notes: null, c_qty: null })]);
    await act(async () => cellButton("r1", "c_name").click());
    await act(async () => editor()!.dispatchEvent(pasteEvent("1 Mill Lane\r\nYork\r\n")));
    expect(editor()?.value).toBe("1 Mill Lane York");
    expect(databases.updateRows).not.toHaveBeenCalled();
    expect(databases.insertRows).not.toHaveBeenCalled();
  });

  it("copies a focused cell as the editor would show it", async () => {
    await render([row("r1", { c_name: "a", c_notes: null, c_qty: 1234.5 })]);
    const setData = vi.fn();
    const e = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { setData } });
    await act(async () => cellButton("r1", "c_qty").dispatchEvent(e));
    expect(setData).toHaveBeenCalledWith("text/plain", "1234.5");
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("searching the table", () => {
  it("asks the node for the rows holding the words once typing pauses, and tells the page what a download should write", async () => {
    const onListing = vi.fn();
    await render([row("r1", { c_name: "Sourdough", c_notes: "Flour from Miller", c_qty: 2 })], onListing);
    expect(onListing).toHaveBeenLastCalledWith({ tableId: "t1", listing: { sort: [], filter: null, group_by: null }, columns: ["c_name", "c_notes", "c_qty"] });

    databases.listRows.mockResolvedValue({ rows: [], total: 0 });
    const box = host.querySelector<HTMLInputElement>('.db-search input[placeholder="Search this table"]');
    await typeInto(box, " flour ");
    expect(databases.listRows).toHaveBeenCalledTimes(1);
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(databases.listRows).toHaveBeenLastCalledWith("db1", "t1", expect.objectContaining({ search: "flour", offset: 0 }));
    expect(onListing).toHaveBeenLastCalledWith(expect.objectContaining({ listing: expect.objectContaining({ search: "flour" }) }));
    expect(host.textContent).toContain("No rows match “flour”");

    databases.listRows.mockResolvedValue({ rows: [row("r1", { c_name: "Sourdough", c_notes: null, c_qty: 2 })], total: 1 });
    const clear = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear search")!;
    await act(async () => clear.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(databases.listRows.mock.lastCall![2]).not.toHaveProperty("search");
    expect(box!.value).toBe("");
  });

  it("searches the start of a text longer than the node takes, rather than failing the listing", async () => {
    await render([row("r1", { c_name: "Sourdough", c_notes: null, c_qty: 2 })]);
    const box = host.querySelector<HTMLInputElement>('.db-search input[placeholder="Search this table"]');
    await typeInto(box, "a".repeat(DATABASE_ROW_SEARCH_MAX_CHARS + 50));
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(databases.listRows).toHaveBeenLastCalledWith("db1", "t1", expect.objectContaining({ search: "a".repeat(DATABASE_ROW_SEARCH_MAX_CHARS) }));
  });
});
