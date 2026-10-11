import { describe, expect, it } from "vitest";
import type { DatabaseImportHeader } from "@stuga/protocol/databases/types";
import { checkedAs, choiceCounts, defaultChoices, importShape, mappableHeaders, tableNameFromFile } from "./import-mapping";

const h = (header: string, rest: Partial<DatabaseImportHeader> = {}): DatabaseImportHeader => ({ header, column_id: null, new_type: "text", ...rest });

const CHECK = {
  headers: [
    h("Name", { column_id: "c_name" }),
    h("Pricee", { new_type: "number", suggestion: "c_price" }),
    h("Phone"),
    h("_id"),
    h(""),
    h("Name", { column_id: "c_name" }),
  ],
  ignored_columns: ["_id"],
};

describe("defaultChoices", () => {
  it("takes the matched column, else the one a typo away, else a new column, and leaves export fields out", () => {
    expect(mappableHeaders(CHECK).map((x) => x.header)).toEqual(["Name", "Pricee", "Phone"]);
    expect(defaultChoices(CHECK, { kind: "table" })).toEqual({
      Name: { kind: "column", columnId: "c_name" },
      Pricee: { kind: "column", columnId: "c_price" },
      Phone: { kind: "new" },
    });
  });

  it("offers a close match only when no other header already fills that column", () => {
    const check = { headers: [h("Price", { column_id: "c_price" }), h("Pricee", { suggestion: "c_price" })] };
    expect(defaultChoices(check, { kind: "table" }).Pricee).toEqual({ kind: "new" });
  });

  it("makes every header a new column of a new table", () => {
    expect(Object.values(defaultChoices(CHECK, { kind: "new", name: "Prices" }))).toEqual([{ kind: "new" }, { kind: "new" }, { kind: "new" }]);
  });
});

describe("importShape", () => {
  it("tells the node where each header goes", () => {
    const choices = { Name: { kind: "column", columnId: "c_name" }, Pricee: { kind: "new" }, Phone: { kind: "skip" } } as const;
    expect(importShape(choices, { kind: "table" })).toEqual({ column_map: { Name: "c_name", Phone: null }, new_columns: ["Pricee"] });
    expect(importShape(choices, { kind: "new", name: "Prices" })).toEqual({ column_map: { Phone: null }, new_table: "Prices" });
    expect(importShape({ Name: { kind: "column", columnId: "c_name" } }, { kind: "table" })).toEqual({ column_map: { Name: "c_name" } });
  });
});

describe("checkedAs", () => {
  it("says whether the node's last reading already is what the choices say", () => {
    const read = { headers: [h("Name", { column_id: "c_name" }), h("Price", { new: true }), h("Note")], ignored_columns: ["Note"] };
    const same = { Name: { kind: "column", columnId: "c_name" }, Price: { kind: "new" }, Note: { kind: "skip" } } as const;
    expect(checkedAs(read, same)).toBe(true);
    expect(checkedAs(read, { ...same, Price: { kind: "skip" } })).toBe(false);
    expect(checkedAs(read, { ...same, Name: { kind: "column", columnId: "c_other" } })).toBe(false);
  });
});

describe("choiceCounts and tableNameFromFile", () => {
  it("counts the choices and names a table after its file", () => {
    expect(choiceCounts({ a: { kind: "column", columnId: "x" }, b: { kind: "new" }, c: { kind: "new" }, d: { kind: "skip" } })).toEqual({
      matched: 1,
      added: 2,
      skipped: 1,
    });
    expect(tableNameFromFile("Price list 2026.csv")).toBe("Price list 2026");
    expect(tableNameFromFile("orders.v2.tsv")).toBe("orders.v2");
    expect(tableNameFromFile("README")).toBe("README");
  });
});
