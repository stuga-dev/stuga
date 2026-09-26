// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { DocSummary } from "../api";

const databases = vi.hoisted(() => ({ schema: vi.fn(), createTable: vi.fn() }));
/** What the page hands the runs provider, which calls it once a proposal is applied. */
const runs = vi.hoisted(() => ({ onApplied: null as null | (() => void) }));

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Databases: databases }));
vi.mock("../sync/database-socket", () => ({
  DatabaseSocket: class {
    changedListener = null;
    onStatus = null;
    destroy() {}
  },
}));
vi.mock("../review/db-runs-context", () => ({
  DbRunsProvider: ({ onApplied, children }: { onApplied: () => void; children: ReactNode }) => {
    runs.onApplied = onApplied;
    return <>{children}</>;
  },
}));
vi.mock("../review/DbRunBar", () => ({ DbRunBar: () => null }));
vi.mock("../review/DbCatchUpCard", () => ({ DbCatchUpCard: () => null }));
vi.mock("../shell/NotificationsBell", () => ({ NotificationsBell: () => null }));
vi.mock("../shell/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("../library/ItemOptionsMenu", () => ({ ItemOptionsMenu: () => null }));
vi.mock("../database/DatabaseDock", () => ({
  useDatabaseDock: () => ({ state: { visible: false, active: null }, open: () => {}, toggle: () => {} }),
  DatabaseDock: () => null,
}));
vi.mock("../database/DatabaseGrid", () => ({
  DatabaseGrid: ({ table, activeViewId, onSelectView }: { table: { table_id: string }; activeViewId: string | null; onSelectView: (id: string) => void }) => (
    <button data-testid="grid" data-table={table.table_id} onClick={() => onSelectView("view_breach")}>
      {activeViewId ?? "all rows"}
    </button>
  ),
}));
vi.mock("../database/TableTabs", () => ({
  TableTabs: ({ activeId, onCreate }: { activeId: string | null; onCreate: () => void }) => (
    <button data-testid="tabs" data-active={activeId ?? ""} onClick={onCreate}>
      New table
    </button>
  ),
}));
/** Submits the name "Deadlines" as soon as it opens. */
vi.mock("../ui/PromptDialog", () => ({
  PromptDialog: ({ isOpen, title, onSubmit, onClose }: { isOpen: boolean; title: string; onSubmit: (v: string) => void; onClose: () => void }) =>
    isOpen ? (
      <button
        data-testid={`prompt ${title}`}
        onClick={() => {
          onSubmit("Deadlines");
          onClose();
        }}
      />
    ) : null,
}));

const { DatabasePage } = await import("./DatabasePage");

const DOC: DocSummary = {
  doc_id: "d_1",
  title: "Obligations",
  owner: "user:u_1",
  doc_type: "database",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  trashed: false,
  trashed_at: null,
  parent_id: null,
  locked: false,
  search_hidden: false,
  agent_mode: "review",
  page_of: null,
  page_row: null,
};

const SCHEMA = {
  can_write: true,
  tables: [
    {
      table_id: "tbl_1",
      name: "obligations",
      display: "Obligations",
      position: 0,
      row_count: 30,
      columns: [],
      views: [{ view_id: "view_breach", name: "Breach notification" }],
    },
  ],
};

let host: HTMLDivElement;
let root: Root;
let search = "";

function Search() {
  search = useLocation().search;
  return null;
}

async function render(url: string): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/doc/:docId"
            element={
              <>
                <DatabasePage doc={DOC} />
                <Search />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const grid = () => host.querySelector<HTMLButtonElement>('[data-testid="grid"]');
const tabs = () => host.querySelector<HTMLButtonElement>('[data-testid="tabs"]');
const tableParam = () => new URLSearchParams(search).get("table");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  databases.schema.mockReset().mockResolvedValue(SCHEMA);
  databases.createTable.mockReset();
  runs.onApplied = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("DatabasePage", () => {
  it("keeps the view chosen after it opened when an applied proposal reloads the schema", async () => {
    // Opened without a table, as a link from Review AI edits does.
    await render("/doc/d_1");
    expect(new URLSearchParams(search).get("table")).toBe("tbl_1");

    await act(async () => grid()!.click());
    expect(new URLSearchParams(search).get("view")).toBe("view_breach");

    await act(async () => runs.onApplied!());
    expect(databases.schema).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(search).get("table")).toBe("tbl_1");
    expect(new URLSearchParams(search).get("view")).toBe("view_breach");
    expect(grid()?.textContent).toBe("view_breach");
  });

  it("opens a table it creates, and keeps it open when a later change reloads the schema", async () => {
    await render("/doc/d_1?table=tbl_1");
    const created = { table_id: "tbl_2", name: "deadlines", display: "Deadlines", position: 1, row_count: 0, columns: [], views: [] };
    databases.createTable.mockResolvedValue({ table: created });
    databases.schema.mockResolvedValue({ ...SCHEMA, tables: [...SCHEMA.tables, created] });

    await act(async () => tabs()!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="prompt New table"]')!.click());
    expect(databases.createTable).toHaveBeenCalledWith("d_1", "Deadlines");
    expect(tableParam()).toBe("tbl_2");
    expect(tabs()?.dataset.active).toBe("tbl_2");

    // As a socket's change or an applied proposal reloads it: the URL names the new table, so it stays.
    await act(async () => runs.onApplied!());
    expect(databases.schema).toHaveBeenCalledTimes(3);
    expect(tableParam()).toBe("tbl_2");
    expect(tabs()?.dataset.active).toBe("tbl_2");
    expect(grid()?.dataset.table).toBe("tbl_2");
  });
});
