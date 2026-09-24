import { describe, expect, it } from "vitest";
import { isSafeIdentifier, sanitizeIdentifier, uniquifyIdentifier } from "./identifiers.js";

describe("sanitizeIdentifier", () => {
  it("snake_cases ordinary display names", () => {
    expect(sanitizeIdentifier("Project Name")).toBe("project_name");
    expect(sanitizeIdentifier("  Budget ($)  ")).toBe("budget");
    expect(sanitizeIdentifier("Total-%_done")).toBe("total_done");
  });

  it("folds accented characters instead of dropping the whole word", () => {
    expect(sanitizeIdentifier("Café Menü")).toBe("cafe_menu");
    expect(sanitizeIdentifier("Résumé")).toBe("resume");
  });

  it("prefixes names that do not start with a letter", () => {
    expect(sanitizeIdentifier("2026 Goals")).toBe("c_2026_goals");
    expect(sanitizeIdentifier("42")).toBe("c_42");
  });

  it("falls back to 'c' when nothing survives (emoji-only, punctuation-only)", () => {
    expect(sanitizeIdentifier("🎉🎉🎉")).toBe("c");
    expect(sanitizeIdentifier("!!!")).toBe("c");
    expect(sanitizeIdentifier("")).toBe("c");
  });

  it("suffixes SQLite keywords and BREAKS the sqlite_ prefix (suffixing wouldn't)", () => {
    expect(sanitizeIdentifier("Select")).toBe("select_x");
    expect(sanitizeIdentifier("ORDER")).toBe("order_x");
    expect(sanitizeIdentifier("sqlite_master")).toBe("c_sqlite_master");
    expect(isSafeIdentifier(sanitizeIdentifier("sqlite_master"))).toBe(true);
    expect(isSafeIdentifier(sanitizeIdentifier("SQLite Stats"))).toBe(true);
    expect(isSafeIdentifier(sanitizeIdentifier("sqlite backup"))).toBe(true);
  });

  it("truncates long names but never ends on an underscore", () => {
    const out = sanitizeIdentifier("a".repeat(100));
    expect(out).toBe("a".repeat(34));
    const trimmed = sanitizeIdentifier(`${"b".repeat(33)} tail`);
    expect(trimmed.endsWith("_")).toBe(false);
  });

  it("always yields a safe identifier, on arbitrary garbage", () => {
    const nasty = [
      "Robert'); DROP TABLE students;--",
      '"; DELETE FROM x; --',
      "_tables",
      "__proto__",
      "名前",
      "a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3",
      "sqlite_master",
      "SQLITE_temp_store",
      "sqlite sequence",
    ];
    for (const n of nasty) expect(isSafeIdentifier(sanitizeIdentifier(n))).toBe(true);
  });
});

describe("isSafeIdentifier", () => {
  it("accepts the grammar and rejects everything else", () => {
    expect(isSafeIdentifier("projects")).toBe(true);
    expect(isSafeIdentifier("time_entries_2")).toBe(true);
    expect(isSafeIdentifier("_tables")).toBe(false); // meta namespace
    expect(isSafeIdentifier("Projects")).toBe(false); // uppercase
    expect(isSafeIdentifier("select")).toBe(false); // keyword
    expect(isSafeIdentifier("sqlite_seq")).toBe(false);
    expect(isSafeIdentifier("a".repeat(41))).toBe(false);
    expect(isSafeIdentifier("")).toBe(false);
    expect(isSafeIdentifier('pro"jects')).toBe(false);
  });
});

describe("uniquifyIdentifier", () => {
  it("counts up from _2 against taken names", () => {
    const taken = new Set(["tasks", "tasks_2"]);
    expect(uniquifyIdentifier("tasks", taken)).toBe("tasks_3");
    expect(uniquifyIdentifier("other", taken)).toBe("other");
  });
});
