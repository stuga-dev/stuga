import { describe, it, expect } from "vitest";
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_STATUSES,
  CSV_BOM,
  auditExportFilename,
  csvCell,
  isAuditStatus,
  type AuditExportColumn,
} from "./audit.js";

describe("csvCell — the value it is given", () => {
  it("passes an ordinary string through bare", () => {
    expect(csvCell("Quarterly notes")).toBe("Quarterly notes");
  });

  it("renders nothing for null and undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("keeps the falsy scalars that are not empty", () => {
    expect(csvCell(0)).toBe("0");
    expect(csvCell(false)).toBe("false");
  });

  it("serialises objects and arrays as JSON", () => {
    expect(csvCell({ mode: "auto_applied", hunks: 2 })).toBe('"{""mode"":""auto_applied"",""hunks"":2}"');
    expect(csvCell([1, 2])).toBe('"[1,2]"');
  });
});

describe("csvCell — RFC 4180 quoting", () => {
  it("quotes a value carrying the delimiter", () => {
    expect(csvCell("Smith, Jane")).toBe('"Smith, Jane"');
  });

  it("quotes and doubles an inner quote", () => {
    expect(csvCell('He said "no"')).toBe('"He said ""no"""');
  });

  it("quotes a value carrying a line break, LF or CRLF", () => {
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
    expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
  });

  it("quotes leading and trailing whitespace, which a bare cell loses", () => {
    expect(csvCell(" padded")).toBe('" padded"');
    expect(csvCell("padded ")).toBe('"padded "');
  });
});

describe("csvCell — the formula guard", () => {
  it("prefixes an apostrophe to each formula introducer", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1")).toBe("\"'+1\"");
    expect(csvCell("@SUM(A1)")).toBe("\"'@SUM(A1)\"");
  });

  it("guards a leading minus, so a negative number exports as text", () => {
    expect(csvCell(-5)).toBe("\"'-5\"");
  });

  it("guards a leading TAB or CR, which an importer eats to expose what follows", () => {
    expect(csvCell("\t=cmd")).toBe("\"'\t=cmd\"");
    expect(csvCell("\r=cmd")).toBe("\"'\r=cmd\"");
  });

  it("leaves a formula character that is not first alone", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("2-1")).toBe("2-1");
  });

  it("emits no terminator of its own, and eats none — the joining site owns CRLF", () => {
    expect(csvCell("row")).toBe("row");
    expect(csvCell("row\n")).toBe('"row\n"');
    expect(csvCell("row\r\n")).toBe('"row\r\n"');
  });
});

describe("the export column list", () => {
  it("is exactly these thirteen names, in this order", () => {
    expect(AUDIT_EXPORT_COLUMNS).toEqual([
      "id",
      "at",
      "actor",
      "actor_kind",
      "on_behalf_of",
      "source",
      "action",
      "target_kind",
      "target_id",
      "target_label",
      "status",
      "request_id",
      "detail",
    ]);
  });

  it("names no column twice", () => {
    expect(new Set(AUDIT_EXPORT_COLUMNS).size).toBe(AUDIT_EXPORT_COLUMNS.length);
  });

  // Checked by tsc: dropping the list's `as const` would widen the column type to string.
  type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
  const columnTypeIsExact: Exactly<
    AuditExportColumn,
    | "id"
    | "at"
    | "actor"
    | "actor_kind"
    | "on_behalf_of"
    | "source"
    | "action"
    | "target_kind"
    | "target_id"
    | "target_label"
    | "status"
    | "request_id"
    | "detail"
  > = true;

  it("types a column as exactly one of those thirteen names, never as a string", () => {
    expect(columnTypeIsExact).toBe(true);
  });
});

describe("the byte-order mark", () => {
  it("is one U+FEFF, so a CSV opens as UTF-8 rather than a legacy code page", () => {
    expect(CSV_BOM).toBe("﻿");
    expect(CSV_BOM.length).toBe(1);
  });
});

describe("audit statuses", () => {
  it("holds the whole vocabulary", () => {
    expect(AUDIT_STATUSES).toEqual(["ok", "denied"]);
  });

  it("accepts exactly those, and nothing shaped like them", () => {
    for (const s of AUDIT_STATUSES) expect(isAuditStatus(s)).toBe(true);
    for (const bad of ["OK", "Denied", "error", "", null, undefined, 0]) expect(isAuditStatus(bad)).toBe(false);
  });
});

describe("auditExportFilename", () => {
  it("names the date-stamped file", () => {
    expect(auditExportFilename("2026-09-05", "csv")).toBe("stuga-audit-2026-09-05.csv");
  });

  it("carries the format in the extension", () => {
    expect(auditExportFilename("2026-09-05", "ndjson")).toBe("stuga-audit-2026-09-05.ndjson");
  });
});
