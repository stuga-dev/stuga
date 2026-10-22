import { afterEach, describe, expect, it, vi } from "vitest";
import { logNotice, pgConnection } from "./client.js";

describe("pgConnection", () => {
  it("lifts a socket directory and role out of the URL, decoded", () => {
    expect(pgConnection("postgres:///stuga?host=/Library/Application%20Support/Stuga/data/run&user=stuga")).toEqual({
      url: "postgres:///stuga",
      options: { host: "/Library/Application Support/Stuga/data/run", user: "stuga" },
    });
  });

  it("keeps every other parameter in the URL", () => {
    expect(pgConnection("postgres://u:p@db:5432/stuga?sslmode=require&port=6543")).toEqual({
      url: "postgres://u:p@db:5432/stuga?sslmode=require",
      options: { port: 6543 },
    });
  });

  it("leaves a URL without parameters alone", () => {
    expect(pgConnection("postgres://stuga:stuga@127.0.0.1:55433/stuga")).toEqual({
      url: "postgres://stuga:stuga@127.0.0.1:55433/stuga",
      options: {},
    });
  });
});

describe("logNotice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs every notice as one line, a warning included", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logNotice({ severity: "NOTICE", code: "42P06", message: 'schema "audit" already exists, skipping', routine: "CreateSchemaCommand" });
    logNotice({ severity: "WARNING", code: "01000", message: "something else", routine: "exec_stmt_raise" });
    expect(warn.mock.calls).toEqual([
      ['[postgres] NOTICE: schema "audit" already exists, skipping'],
      ["[postgres] WARNING: something else"],
    ]);
  });
});
