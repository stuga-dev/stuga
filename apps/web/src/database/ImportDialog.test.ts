import { describe, expect, it } from "vitest";
import type { TableSchema } from "@stuga/protocol/databases/types";
import { importHint, importProblem, importTemplateCsv } from "./ImportDialog";

const table: TableSchema = {
  table_id: "t1",
  name: "bookings",
  display: "Bookings",
  position: 0,
  views: [],
  row_count: 0,
  columns: [
    { column_id: "c1", name: "guest_name", display: "Guest, full", type: "text", position: 0, options: null },
    { column_id: "c2", name: "nightly_rate", display: "Nightly Rate", type: "number", position: 1, options: null },
    { column_id: "c3", name: "breakfast", display: "Breakfast", type: "checkbox", position: 2, options: null },
    { column_id: "c4", name: "check_in", display: "Check In", type: "date", position: 3, options: null },
    { column_id: "c5", name: "status", display: "Status", type: "single_select", position: 4, options: { choices: ["Confirmed", "Cancelled"] } },
  ],
};

describe("importTemplateCsv", () => {
  it("writes display-name headers the importer matches, quoted where needed, and no example rows", () => {
    expect(importTemplateCsv(table)).toBe('"Guest, full",Nightly Rate,Breakfast,Check In,Status\r\n');
  });
});

// The node's sentences, as services/node/src/databases/imports/format.ts writes them.
describe("importProblem and importHint", () => {
  it("reads the counts out of a malformed row", () => {
    expect(importProblem({ row: 3, code: "malformed_row", message: "row has 4 fields but the header has 5" })).toBe(
      "This row has 4 fields, but the header has 5.",
    );
    expect(importProblem({ row: 2, code: "malformed_row", message: "not valid JSON: Unexpected token" })).toBe("This row can’t be read.");
    expect(importProblem({ row: 0, code: "malformed_row", message: "expected a JSON array of objects" })).toBe("The file can’t be read.");
  });

  it("says a refused cell from its code, or from the validator’s reason when it carries one", () => {
    expect(importProblem({ row: 2, column: "Rate", value: "abc", code: "invalid_number", message: "not a number" })).toBe("Not a number.");
    expect(importProblem({ row: 2, column: "Notes", value: "…", code: "invalid_text", message: "text too long (max 16384 bytes)" })).toBe(
      "Text too long: the limit is 16,384 bytes.",
    );
  });

  it("translates the near-miss and the choices hints", () => {
    const base = { row: 2, column: "Status", value: "Confrmed", code: "invalid_choice" as const, message: "not one of the column's choices" };
    expect(importHint({ ...base, hint: 'did you mean "Confirmed"?' })).toBe("Did you mean “Confirmed”?");
    expect(importHint({ ...base, hint: "choices: Confirmed, Cancelled" })).toBe("Choices: Confirmed, Cancelled");
    expect(importHint({ ...base, code: "invalid_date", hint: "2026-01-04, 1/4/26 and 4 Jan 2026 all work" })).toBe(
      "2026-01-04, 1/4/26 and 4 Jan 2026 all work.",
    );
    expect(importHint({ ...base })).toBeNull();
  });
});
