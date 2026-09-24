import { describe, expect, it } from "vitest";
import { errorMessage, formatForFile, mutationRequest } from "./rest-backend.js";

describe("mutationRequest", () => {
  it("creates a table, with its columns, through the tables route", () => {
    expect(mutationRequest("db1", { action: "create_table", display: "Tasks" })).toEqual({
      path: "/api/databases/db1/tables",
      method: "POST",
      body: { display: "Tasks" },
    });
    expect(mutationRequest("db1", { action: "create_table", display: "Guests", columns: [{ name: "A", type: "text" }] })).toMatchObject({
      body: { display: "Guests", columns: [{ name: "A", type: "text" }] },
    });
  });

  it("adds a column under the table, carrying single_select choices and the description", () => {
    expect(mutationRequest("db1", { action: "add_column", table_id: "t1", display: "Status", type: "single_select", choices: ["todo"] })).toEqual({
      path: "/api/databases/db1/tables/t1/columns",
      method: "POST",
      body: { display: "Status", type: "single_select", choices: ["todo"] },
    });
    expect(
      mutationRequest("db1", { action: "add_column", table_id: "t1", display: "Amount", type: "number", description: "USD, net of refunds" }),
    ).toEqual({
      path: "/api/databases/db1/tables/t1/columns",
      method: "POST",
      body: { display: "Amount", type: "number", description: "USD, net of refunds" },
    });
  });

  it("inserts with POST and updates with PATCH on the rows route", () => {
    expect(mutationRequest("db1", { action: "insert_rows", table_id: "t1", rows: [{ Name: "a" }] })).toEqual({
      path: "/api/databases/db1/tables/t1/rows",
      method: "POST",
      body: { rows: [{ Name: "a" }] },
    });
    expect(mutationRequest("db1", { action: "update_rows", table_id: "t1", updates: [{ _id: "r1", values: { Name: "c" } }] })).toEqual({
      path: "/api/databases/db1/tables/t1/rows",
      method: "PATCH",
      body: { updates: [{ _id: "r1", values: { Name: "c" } }] },
    });
  });

  it("deletes rows by POST, with the ids in the body", () => {
    expect(mutationRequest("db1", { action: "delete_rows", table_id: "t1", row_ids: ["r1", "r2"] })).toEqual({
      path: "/api/databases/db1/tables/t1/rows/delete",
      method: "POST",
      body: { row_ids: ["r1", "r2"] },
    });
  });

  it("creates a view as given and patches one by id", () => {
    expect(
      mutationRequest("db1", { action: "create_view", table_id: "t1", view: { name: "Open", filter: { column_id: "c1", op: "empty" }, hidden_columns: ["c2"] } }),
    ).toEqual({
      path: "/api/databases/db1/tables/t1/views",
      method: "POST",
      body: { name: "Open", filter: { column_id: "c1", op: "empty" }, hidden_columns: ["c2"] },
    });
    expect(mutationRequest("db1", { action: "update_view", table_id: "t1", view_id: "view_1", changes: { name: "Renamed", group_by: null } })).toEqual({
      path: "/api/databases/db1/tables/t1/views/view_1",
      method: "PATCH",
      body: { name: "Renamed", group_by: null },
    });
  });

  it("escapes ids into the path", () => {
    expect(mutationRequest("db/1", { action: "insert_rows", table_id: "t 1", rows: [{ a: 1 }] })).toMatchObject({
      path: "/api/databases/db%2F1/tables/t%201/rows",
    });
  });
});

describe("formatForFile", () => {
  it("infers the format from the extension unless told", () => {
    expect(formatForFile("/x/rows.csv", undefined)).toBe("csv");
    expect(formatForFile("/x/rows.TSV", undefined)).toBe("csv");
    expect(formatForFile("/x/rows.jsonl", undefined)).toBe("jsonl");
    expect(formatForFile("/x/rows.json", undefined)).toBe("jsonl");
    expect(formatForFile("/x/rows", undefined)).toBe("csv");
    expect(formatForFile("/x/rows.csv", "jsonl")).toBe("jsonl");
    expect(formatForFile("/x/rows.parquet", undefined)).toEqual({ error: 'cannot tell the format of "/x/rows.parquet" — pass format: csv | jsonl' });
  });
});

describe("errorMessage", () => {
  it("prefers the node's error field, then message, then a plain-text body", () => {
    expect(errorMessage({ error: "view-only access" }, 403)).toBe("view-only access");
    expect(errorMessage({ message: "document changed; re-read and retry" }, 409)).toBe("document changed; re-read and retry");
    expect(errorMessage("upstream exploded", 502)).toBe("upstream exploded");
  });

  it("falls back to the status for an empty body", () => {
    expect(errorMessage(null, 500)).toBe("request failed (500)");
    expect(errorMessage({}, 404)).toBe("request failed (404)");
  });
});
