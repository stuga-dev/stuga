import { describe, expect, it } from "vitest";
import type { TableSchema } from "@stuga/protocol/databases/types";
import { importTemplateCsv } from "./ImportDialog";

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
