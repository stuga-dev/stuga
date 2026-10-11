// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { DatabaseImportCheck, TableSchema } from "@stuga/protocol/databases/types";
import { chooseRadio, mountInto, typeInto } from "../test/form-input";

const databases = vi.hoisted(() => ({ stageImport: vi.fn(), checkImport: vi.fn(), commitImport: vi.fn(), importFile: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Databases: databases }));

const { ImportDialog } = await import("./ImportDialog");

const TABLE: TableSchema = {
  table_id: "t1",
  name: "stock",
  display: "Stock",
  position: 0,
  row_count: 3,
  views: [],
  columns: [
    { column_id: "c_name", name: "name", display: "Name", type: "text", position: 0, options: null },
    { column_id: "c_price", name: "price", display: "Price", type: "number", position: 1, options: null },
  ],
};

/** The node's verdict on a file of Name, Pricee and Phone, as read with `opts`. */
function verdict(opts: { column_map?: Record<string, string | null>; new_columns?: string[]; new_table?: string }): DatabaseImportCheck {
  const shaped = opts.column_map !== undefined || opts.new_columns !== undefined || opts.new_table !== undefined;
  const intoNew = opts.new_table !== undefined;
  const target = (header: string, matched: string | null) => {
    if (opts.column_map?.[header] === null) return { column_id: null };
    if (intoNew || opts.new_columns?.includes(header)) return { column_id: null, new: true as const };
    return { column_id: opts.column_map?.[header] ?? matched };
  };
  const headers = [
    { header: "Name", new_type: "text" as const, ...target("Name", intoNew ? null : "c_name") },
    { header: "Pricee", new_type: "number" as const, ...target("Pricee", null), ...(shaped ? {} : { suggestion: "c_price" }) },
    { header: "Phone", new_type: "text" as const, ...target("Phone", null) },
  ];
  const unmatched = headers.some((h) => h.column_id === null && !("new" in h) && opts.column_map?.[h.header] !== null);
  return {
    import_id: "imp_1",
    dry_run: true,
    rows_total: 2,
    rows_ready: unmatched ? 0 : 2,
    rows_failed: unmatched ? 2 : 0,
    errors: unmatched ? [{ row: 0, column: "Pricee", code: "unknown_column", message: "no column of this table matches this header" }] : [],
    errors_truncated: false,
    matched_columns: headers.flatMap((h) => (h.column_id ? [h.column_id] : [])),
    ignored_columns: Object.entries(opts.column_map ?? {}).flatMap(([h, v]) => (v === null ? [h] : [])),
    headers,
    notes: [],
  };
}

let host: HTMLDivElement;
const onImported = vi.fn();

async function open() {
  const { root } = mountInto();
  host = document.body as HTMLDivElement;
  const file = new File(["Name,Pricee,Phone\nBread,4,555\nCake,12,556\n"], "stock list.csv", { type: "text/csv" });
  await act(async () =>
    root.render(<ImportDialog isOpen docId="db1" table={TABLE} initialFile={file} onClose={() => {}} onImported={onImported} />),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const importButton = () => [...host.querySelectorAll("button")].find((b) => /^Import \d/.test(b.textContent ?? ""));

beforeEach(() => {
  vi.clearAllMocks();
  databases.stageImport.mockResolvedValue({ import_id: "imp_1" });
  databases.checkImport.mockImplementation(async (_db: string, _id: string, opts: Parameters<typeof verdict>[0]) => verdict(opts));
  databases.commitImport.mockResolvedValue({ import_id: "imp_1", mode: "applied", rows_total: 2, rows_ingested: 2, rows_skipped: 0, errors: [], errors_truncated: false, ignored_columns: [], notes: [] });
});

describe("mapping a file's columns", () => {
  it("takes the close match and makes the unknown header a new column, then checks the file as chosen", async () => {
    await open();
    expect(databases.checkImport.mock.calls.map((c) => c[2])).toEqual([
      {},
      { column_map: { Name: "c_name", Pricee: "c_price" }, new_columns: ["Phone"] },
    ]);
    expect(host.textContent).toContain("2 rows ready to import.");
    expect(host.textContent).toContain("2 columns match, 1 new column.");
    expect(host.textContent).not.toContain("None of the");

    await act(async () => importButton()!.click());
    expect(databases.commitImport).toHaveBeenCalledWith("db1", "imp_1", {
      column_map: { Name: "c_name", Pricee: "c_price" },
      new_columns: ["Phone"],
      on_error: "abort",
    });
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("lands the file in a new table named after it, every column new", async () => {
    await open();
    await chooseRadio(host, "A new table");
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(databases.checkImport).toHaveBeenLastCalledWith("db1", "imp_1", { new_table: "stock list" });
    expect(host.textContent).toContain("3 new columns.");
    const name = [...host.querySelectorAll<HTMLInputElement>("input")].find((i) => i.value === "stock list")!;
    await typeInto(name, "Stock 2026");
    await act(async () => importButton()!.click());
    expect(databases.commitImport).toHaveBeenCalledWith("db1", "imp_1", { new_table: "Stock 2026", on_error: "abort" });
  });
});
