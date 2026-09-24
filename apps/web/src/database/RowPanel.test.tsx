// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { RowRecord, TableSchema } from "@stuga/protocol/databases/types";

const databases = vi.hoisted(() => ({ listRows: vi.fn(), openRowPage: vi.fn(), updateRows: vi.fn() }));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type: string }> }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Databases: databases,
}));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type: string }) => toasts.shown.push(t),
}));

const { RowPanel } = await import("./RowPanel");

const TABLE: TableSchema = {
  table_id: "t1",
  name: "tasks",
  display: "Tasks",
  position: 0,
  row_count: 1,
  columns: [{ column_id: "c_name", name: "name", display: "Name", type: "text", position: 0, options: null }],
  views: [],
};

/** A listed row. Through unknown: RowRecord's index signature of cell values cannot hold the boolean `_doc_trashed`. */
const row = (over: { _doc_id?: string | null; _doc_trashed?: boolean } = {}): RowRecord =>
  ({ _id: "r1", _created_at: 0, _updated_at: 0, c_name: "Task 11", ...over }) as unknown as RowRecord;

let host: HTMLDivElement;
let root: Root;
const onSaved = vi.fn();

function Where() {
  const loc = useLocation();
  return <output data-testid="path">{loc.pathname + loc.search}</output>;
}

const path = () => host.querySelector('[data-testid="path"]')?.textContent;
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

async function render(readOnly = false) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/doc/db1?table=t1&row=r1"]}>
        <RowPanel docId="db1" table={TABLE} rowId="r1" refreshKey={0} readOnly={readOnly} onSaved={onSaved} onWriteDenied={() => {}} />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
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

describe("RowPanel's page actions", () => {
  it("offers a row whose page is in the Trash a new page beside restoring the old one", async () => {
    databases.listRows.mockResolvedValue({ rows: [row({ _doc_id: "page1", _doc_trashed: true })], total: 1 });
    databases.openRowPage.mockResolvedValue({ doc_id: "page2", created: true });
    await render();
    expect(button("Restore page")).toBeTruthy();
    await click("Create page");
    expect(databases.openRowPage).toHaveBeenCalledWith("db1", "t1", "r1", { replaceTrashed: true });
    expect(onSaved).toHaveBeenCalled();
    expect(path()).toBe(`/doc/page2?row=${encodeURIComponent("db1.t1.r1")}`);
  });

  it("restores the trashed page when asked to", async () => {
    databases.listRows.mockResolvedValue({ rows: [row({ _doc_id: "page1", _doc_trashed: true })], total: 1 });
    databases.openRowPage.mockResolvedValue({ doc_id: "page1", created: false, restored: true });
    await render();
    await click("Restore page");
    expect(databases.openRowPage).toHaveBeenCalledWith("db1", "t1", "r1", { replaceTrashed: false });
    expect(path()).toBe(`/doc/page1?row=${encodeURIComponent("db1.t1.r1")}`);
  });

  it("gives a reader neither action, only word that the page is in the Trash", async () => {
    databases.listRows.mockResolvedValue({ rows: [row({ _doc_id: "page1", _doc_trashed: true })], total: 1 });
    await render(true);
    expect(button("Create page")).toBeUndefined();
    expect(button("Restore page")).toBeUndefined();
    expect(host.textContent).toContain("This row's page is in the Trash.");
  });

  it("keeps one action for a row with a live page or none", async () => {
    databases.listRows.mockResolvedValue({ rows: [row({ _doc_id: "page1" })], total: 1 });
    await render();
    expect(button("Open page")).toBeTruthy();
    expect(button("Restore page")).toBeUndefined();

    databases.listRows.mockResolvedValue({ rows: [row({ _doc_id: null })], total: 1 });
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(button("Create page")).toBeTruthy();
    expect(button("Restore page")).toBeUndefined();
  });
});
