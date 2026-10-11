/** What leaves a database for people: a search of a table, every row of a listing, the text the workspace search reads, and the first table's name. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATABASE_ROW_SEARCH_MAX_CHARS, DATABASE_ROWS_PAGE_MAX } from "@stuga/protocol/databases/limits";
import { HUMAN, colId, doFetch, doJson, initStarter, makeActor } from "../test/harness.js";
import { databaseSearchText } from "./query/search-text.js";

type Row = Record<string, unknown> & { _id: string };
type ListOut = { rows: Row[]; total: number };
type Table = Awaited<ReturnType<typeof initStarter>>;

/** A table of a few kinds of cell: Name, Notes, Done, Price, Day and Kind. */
async function bakery() {
  const made = makeActor();
  const t = await initStarter(made.actor);
  for (const col of [
    { display: "Price", type: "number" },
    { display: "Day", type: "date" },
    { display: "Kind", type: "single_select", choices: ["Bread", "Cake"] },
  ]) {
    await doJson(made.actor, "/columns/add", { table_id: t.table_id, ...col, actor: HUMAN });
  }
  const schema = await doJson<{ tables: Table[] }>(made.actor, "/schema");
  const table = schema.tables[0]!;
  await doJson(made.actor, "/rows/insert", {
    table_id: table.table_id,
    rows: [
      { Name: "Sourdough loaf", Notes: "Flour from Miller", Done: true, Price: 4.5, Day: "2026-10-15", Kind: "Bread" },
      { Name: "Matcha cake", Notes: "抹茶蛋糕, 100% green", Price: 12, Kind: "Cake" },
      { Name: "Rye_bread", Notes: "Line one\nline two", Price: 3, Day: "2026-11-01" },
    ],
    actor: HUMAN,
  });
  return { ...made, table };
}

const names = (out: ListOut, table: Table) => out.rows.map((r) => r[colId(table, "Name")]);

describe("searching a table", () => {
  it("keeps the rows with the words in any text, choice, number or date cell, ignoring case", async () => {
    const { actor, table } = await bakery();
    const search = async (q: string) => names(await doJson<ListOut>(actor, "/rows/list", { table_id: table.table_id, search: q }), table);
    expect(await search("miller")).toEqual(["Sourdough loaf"]);
    expect(await search("抹茶")).toEqual(["Matcha cake"]);
    expect(await search("cake")).toEqual(["Matcha cake"]);
    expect(await search("4.5")).toEqual(["Sourdough loaf"]);
    expect(await search("2026-11")).toEqual(["Rye_bread"]);
    expect(await search("  ")).toEqual(["Sourdough loaf", "Matcha cake", "Rye_bread"]);
    // LIKE's own wildcards are words like any other.
    expect(await search("100%")).toEqual(["Matcha cake"]);
    expect(await search("e_b")).toEqual(["Rye_bread"]);
    expect(await search("nothing like it")).toEqual([]);
  });

  it("narrows a filtered listing further and counts what is left", async () => {
    const { actor, table } = await bakery();
    const out = await doJson<ListOut>(actor, "/rows/list", {
      table_id: table.table_id,
      filter: { column_id: colId(table, "Price"), op: "lt", value: 10 },
      search: "bread",
    });
    expect(out.total).toBe(2);
    expect(names(out, table)).toEqual(["Sourdough loaf", "Rye_bread"]);
  });

  it("refuses a search that is too long, not a string, or paired with `after`", async () => {
    const { actor, table } = await bakery();
    for (const body of [{ search: "x".repeat(DATABASE_ROW_SEARCH_MAX_CHARS + 1) }, { search: 5 }, { search: "a", after: null }]) {
      expect((await doFetch(actor, "/rows/list", { table_id: table.table_id, ...body })).status).toBe(400);
    }
  });
});

describe("/rows/export", () => {
  it("returns every row the listing selects, past one page, in its order", async () => {
    const { actor } = makeActor();
    const t = await initStarter(actor);
    const count = DATABASE_ROWS_PAGE_MAX + 25;
    await doJson(actor, "/rows/insert", {
      table_id: t.table_id,
      rows: Array.from({ length: count }, (_, i) => ({ Name: `Row ${String(i).padStart(3, "0")}`, Done: i % 2 === 0 })),
      actor: HUMAN,
    });
    const name = colId(t, "Name");
    const all = await doJson<ListOut>(actor, "/rows/export", { table_id: t.table_id, sort: { column_id: name, dir: "desc" } });
    expect(all.rows).toHaveLength(count);
    expect(all.rows[0]![name]).toBe(`Row ${count - 1}`);
    const some = await doJson<ListOut>(actor, "/rows/export", {
      table_id: t.table_id,
      filter: { column_id: colId(t, "Done"), op: "eq", value: 1 },
      search: "Row 00",
    });
    expect(some.rows.map((r) => r[name])).toEqual(["Row 000", "Row 002", "Row 004", "Row 006", "Row 008"]);
  });
});

describe("the text the workspace search reads", () => {
  it("names each table, then a line per row of its cells as a person reads them", async () => {
    const { actor, h } = await bakery();
    const out = await doJson<{ text: string }>(actor, "/search-text");
    expect(out.text).toBe(
      [
        "Table 1",
        "Sourdough loaf · Flour from Miller · 4.5 · 2026-10-15 · Bread",
        "Matcha cake · 抹茶蛋糕, 100% green · 12 · Cake",
        "Rye_bread · Line one line two · 3 · 2026-11-01",
      ].join("\n"),
    );
    // Cut at whole lines, never past the cap.
    const cut = databaseSearchText(h.state.storage, 80);
    expect(cut).toBe("Table 1\nSourdough loaf · Flour from Miller · 4.5 · 2026-10-15 · Bread");
  });

  afterEach(() => vi.useRealTimers());

  it("asks the node to read it again once changes go quiet, once for a burst", async () => {
    vi.useFakeTimers();
    const { actor, h, table } = await bakery();
    const indexJobs = () => h.jobs.sent.filter((m) => m.kind === "index_doc");
    vi.advanceTimersByTime(2_000);
    h.jobs.sent.length = 0;
    await doJson(actor, "/rows/insert", { table_id: table.table_id, rows: [{ Name: "Brioche" }], actor: HUMAN });
    vi.advanceTimersByTime(1_000);
    await doJson(actor, "/rows/insert", { table_id: table.table_id, rows: [{ Name: "Bagel" }], actor: HUMAN });
    expect(indexJobs()).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(indexJobs()).toEqual([{ kind: "index_doc", docId: "db_test", reason: "database_changed" }]);
  });
});

describe("the first table follows the database's name", () => {
  const tables = async (actor: Awaited<ReturnType<typeof makeActor>>["actor"]) =>
    (await doJson<{ tables: Table[] }>(actor, "/schema")).tables.map((t) => t.display);

  it("takes each new name until someone names the table", async () => {
    const { actor } = makeActor();
    const init = await doJson<{ schema: { tables: Table[] } }>(actor, "/schema/init", { display: "Untitled", follows_title: true, actor: HUMAN });
    const tableId = init.schema.tables[0]!.table_id;
    expect(await doJson(actor, "/tables/follow-title", { display: "Stock", actor: HUMAN })).toEqual({ renamed: true });
    expect(await doJson(actor, "/tables/follow-title", { display: "Stock count", actor: HUMAN })).toEqual({ renamed: true });
    expect(await tables(actor)).toEqual(["Stock count"]);
    // The same name again is no change.
    expect(await doJson(actor, "/tables/follow-title", { display: "Stock count", actor: HUMAN })).toEqual({ renamed: false });

    await doJson(actor, "/tables/rename", { table_id: tableId, display: "Shelf", actor: HUMAN });
    expect(await doJson(actor, "/tables/follow-title", { display: "Bakery", actor: HUMAN })).toEqual({ renamed: false });
    expect(await tables(actor)).toEqual(["Shelf"]);
  });

  it("stops while a second table is there, and never follows for a table its creator named", async () => {
    const { actor } = makeActor();
    await doJson(actor, "/schema/init", { display: "Untitled", follows_title: true, actor: HUMAN });
    const second = await doJson<{ table: Table }>(actor, "/tables/create", { display: "Suppliers", actor: HUMAN });
    expect(await doJson(actor, "/tables/follow-title", { display: "Stock", actor: HUMAN })).toEqual({ renamed: false });
    await doJson(actor, "/tables/delete", { table_id: second.table.table_id, actor: HUMAN });
    expect(await doJson(actor, "/tables/follow-title", { display: "Stock", actor: HUMAN })).toEqual({ renamed: true });

    const named = makeActor().actor;
    await doJson(named, "/schema/init", { display: "Orders", actor: HUMAN });
    expect(await doJson(named, "/tables/follow-title", { display: "Shop", actor: HUMAN })).toEqual({ renamed: false });
    expect(await tables(named)).toEqual(["Orders"]);
  });
});
