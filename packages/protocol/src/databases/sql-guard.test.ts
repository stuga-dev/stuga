import { describe, expect, it } from "vitest";
import { DATABASE_QUERY_MAX_BYTES } from "./limits.js";
import { selectOnlyViolation, stripCommentsAndStrings } from "./sql-guard.js";

describe("stripCommentsAndStrings", () => {
  it("removes literal bodies but keeps structure", () => {
    expect(stripCommentsAndStrings("SELECT 'please update me' FROM t")).toBe(
      "SELECT '' FROM t",
    );
  });

  it("handles doubled-quote escapes", () => {
    expect(stripCommentsAndStrings("SELECT 'it''s an update' FROM t")).toBe(
      "SELECT '' FROM t",
    );
  });

  it("removes comment bodies", () => {
    expect(stripCommentsAndStrings("SELECT 1 -- update everything\nFROM t")).toBe(
      "SELECT 1  \nFROM t",
    );
    expect(stripCommentsAndStrings("SELECT /* delete */ 1")).toBe("SELECT   1");
  });

  it("blanks bracket and backtick identifiers", () => {
    expect(stripCommentsAndStrings("SELECT [update col] FROM `drop tbl`")).toBe(
      'SELECT "" FROM ``',
    );
  });

  it("blanks an unterminated string to end-of-input", () => {
    expect(stripCommentsAndStrings("SELECT 'unterminated insert")).toBe("SELECT ''");
  });
});

describe("selectOnlyViolation", () => {
  it("accepts plain SELECTs, WITH-CTEs, JOINs, aggregates", () => {
    expect(selectOnlyViolation("SELECT * FROM projects")).toBeNull();
    expect(selectOnlyViolation("select p.name, sum(t.hours) from projects p join time_entries t on t.project_id = p._id group by p._id")).toBeNull();
    expect(selectOnlyViolation("WITH recent AS (SELECT * FROM tasks WHERE due > '2026-01-01') SELECT count(*) FROM recent")).toBeNull();
  });

  it("refuses a recursive CTE, bounded or not, because an unbounded one cannot be stopped", () => {
    // Unterminated, with an aggregate outside: no row is ever produced to check a deadline against.
    expect(selectOnlyViolation("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT count(*) FROM c")).toMatch(/recursive/i);
    // Bounded recursion is refused too.
    expect(selectOnlyViolation("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 5) SELECT n FROM c")).toMatch(/recursive/i);
    // Case and spacing are not a way around it.
    expect(selectOnlyViolation("with\n  recursive c(n) AS (SELECT 1) SELECT n FROM c")).toMatch(/recursive/i);
    // A non-recursive CTE is untouched, and so is a column called `recursive`.
    expect(selectOnlyViolation("WITH recent AS (SELECT 1) SELECT * FROM recent")).toBeNull();
    expect(selectOnlyViolation("SELECT recursive FROM t")).toBeNull();
  });

  it("refuses a self-referencing CTE that omits the optional RECURSIVE keyword", () => {
    expect(selectOnlyViolation("WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT count(*) FROM c")).toMatch(/recursive/i);
    expect(selectOnlyViolation("WiTh c (n) aS ( SELECT 1 UNION ALL SELECT n+1 FROM   c ) SELECT n FROM c")).toMatch(/recursive/i);
    // Without a column list either.
    expect(selectOnlyViolation("WITH c AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM c) SELECT count(*) FROM c")).toMatch(/recursive/i);
    // The optimizer hints sit between AS and the body; they must not hide it.
    expect(selectOnlyViolation("WITH c AS MATERIALIZED (SELECT 1 UNION ALL SELECT * FROM c) SELECT * FROM c")).toMatch(/recursive/i);
    expect(selectOnlyViolation("WITH c AS NOT MATERIALIZED (SELECT 1 UNION ALL SELECT * FROM c) SELECT * FROM c")).toMatch(/recursive/i);
    // CTEs that chain into each other keep working.
    expect(selectOnlyViolation("WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b")).toBeNull();
    // A WITH clause too tangled to prove non-recursive is refused, not guessed at.
    expect(selectOnlyViolation("WITH c AS (SELECT 1")).not.toBeNull();
  });

  it("allows a trailing semicolon but not multiple statements", () => {
    expect(selectOnlyViolation("SELECT 1;")).toBeNull();
    expect(selectOnlyViolation("SELECT 1; SELECT 2")).toMatch(/one statement/);
  });

  it("blocks WITH ... INSERT despite the WITH prefix", () => {
    expect(
      selectOnlyViolation("WITH x AS (SELECT 1) INSERT INTO projects (name) SELECT 'x' FROM x"),
    ).toMatch(/INSERT/);
  });

  it("blocks write/DDL verbs wherever they appear", () => {
    for (const q of [
      "UPDATE projects SET name = 'x'",
      "DELETE FROM projects",
      "DROP TABLE projects",
      "CREATE TABLE evil (x)",
      "ALTER TABLE projects ADD COLUMN evil TEXT",
      "ATTACH DATABASE 'x' AS y",
      "PRAGMA writable_schema = ON",
      "VACUUM",
      "BEGIN; DROP TABLE projects",
      "REPLACE INTO projects VALUES (1)",
    ]) {
      expect(selectOnlyViolation(q)).not.toBeNull();
    }
  });

  it("does not confuse the replace() string function with REPLACE INTO", () => {
    expect(selectOnlyViolation("SELECT replace(name, 'a', 'b') FROM projects")).toBeNull();
    expect(selectOnlyViolation("SELECT REPLACE\n  INTO_col FROM t")).toBeNull(); // odd but not a write
  });

  it("is not fooled by keywords hidden in comments or literals", () => {
    expect(selectOnlyViolation("SEL/**/ECT * FROM t")).toMatch(/only SELECT/);
    expect(selectOnlyViolation("SELECT * FROM notes WHERE body LIKE '%drop table%'")).toBeNull();
    expect(selectOnlyViolation("SELECT 1 -- drop table\nFROM t")).toBeNull();
  });

  it("allows pragma_table_info-style table-valued functions (word boundary)", () => {
    expect(selectOnlyViolation("SELECT * FROM pragma_table_info('projects')")).toBeNull();
  });

  it("refuses a WITH that is not the first thing in the query", () => {
    expect(
      selectOnlyViolation("SELECT count(*) FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT n FROM c)"),
    ).not.toBeNull();
    // Without the keyword either.
    expect(
      selectOnlyViolation("SELECT count(*) FROM (WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT n FROM c)"),
    ).not.toBeNull();
    // A scalar subquery is the same hole.
    expect(
      selectOnlyViolation("SELECT (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT count(*) FROM c)"),
    ).not.toBeNull();
    // A leading WITH is still fine, and a column called `withdrawals` is not a WITH.
    expect(selectOnlyViolation("WITH a AS (SELECT 1 AS x) SELECT * FROM a")).toBeNull();
    expect(selectOnlyViolation("SELECT withdrawals FROM t")).toBeNull();
  });

  it("sees a self-reference through identifier quoting", () => {
    expect(selectOnlyViolation('WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM "c") SELECT count(*) FROM c')).toMatch(
      /recursive/i,
    );
    expect(selectOnlyViolation("WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM [c]) SELECT count(*) FROM c")).toMatch(
      /recursive/i,
    );
    expect(selectOnlyViolation("WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM `c`) SELECT count(*) FROM c")).toMatch(
      /recursive/i,
    );
    // A quoted identifier that is NOT the CTE's name still passes.
    expect(selectOnlyViolation('WITH c AS (SELECT 1 AS x FROM "other") SELECT * FROM c')).toBeNull();
  });

  it("refuses row sources whose size owes nothing to the tenant's data", () => {
    // The reader's caps are checked between rows; these produce huge joins with no data.
    expect(selectOnlyViolation("SELECT count(*) FROM pragma_function_list a, pragma_function_list b")).toMatch(
      /pragma_function_list/,
    );
    expect(selectOnlyViolation("SELECT * FROM pragma_compile_options")).not.toBeNull();
    expect(selectOnlyViolation("SELECT * FROM pragma_pragma_list")).not.toBeNull();
    // A literal list joined to itself is the same trick without a pragma.
    expect(selectOnlyViolation("SELECT count(*) FROM json_each('[1,2,3]') a, json_each('[1,2,3]') b")).toMatch(/json_each/);
    expect(selectOnlyViolation("SELECT count(*) FROM json_tree('[1,2]')")).not.toBeNull();
    // Over a column the row count is bounded by stored data.
    expect(selectOnlyViolation("SELECT value FROM t, json_each(t.tags)")).toBeNull();
  });

  it("rejects empty and oversized queries", () => {
    expect(selectOnlyViolation("")).toMatch(/empty/);
    expect(selectOnlyViolation("   ")).toMatch(/empty/);
    expect(selectOnlyViolation("-- just a comment")).toMatch(/empty/);
    expect(selectOnlyViolation(`SELECT '${"x".repeat(DATABASE_QUERY_MAX_BYTES)}'`)).toMatch(/too long/);
  });
});
