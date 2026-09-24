import { describe, it, expect } from "vitest";
import { globToLike, orderClause, vectorLiteral } from "./sql.js";

const DIMS = 1024;
const ok = (n = DIMS) => Array.from({ length: n }, (_, i) => (i % 7) * 0.01);

describe("vectorLiteral", () => {
  it("builds a literal for a valid finite vector of the configured width", () => {
    const lit = vectorLiteral(ok(), DIMS);
    expect(lit).not.toBeNull();
    expect(lit!.startsWith("[")).toBe(true);
    expect(lit!.endsWith("]")).toBe(true);
    expect(lit!.split(",").length).toBe(DIMS);
  });

  it("rejects null/undefined", () => {
    expect(vectorLiteral(null, DIMS)).toBeNull();
    expect(vectorLiteral(undefined, DIMS)).toBeNull();
  });

  it("rejects wrong dimensionality", () => {
    expect(vectorLiteral([1, 2, 3], DIMS)).toBeNull();
    expect(vectorLiteral(ok(DIMS + 1), DIMS)).toBeNull();
  });

  it("rejects NaN and Infinity", () => {
    const bad = ok();
    bad[5] = NaN;
    expect(vectorLiteral(bad, DIMS)).toBeNull();
    const bad2 = ok();
    bad2[10] = Infinity;
    expect(vectorLiteral(bad2, DIMS)).toBeNull();
  });

  it("validates against the width it is given, not a built-in default", () => {
    expect(vectorLiteral(ok(1536), 1536)).not.toBeNull();
    expect(vectorLiteral(ok(768), 768)).not.toBeNull();
    expect(vectorLiteral(ok(1024), 1536)).toBeNull();
    expect(vectorLiteral(ok(1536), 1024)).toBeNull();
  });
});

describe("globToLike", () => {
  it("matches a plain filter as a substring and escapes LIKE metacharacters", () => {
    expect(globToLike("plan")).toBe("%plan%");
    expect(globToLike("50%_off")).toBe("%50\\%\\_off%");
  });

  it("turns * and ? into wildcards without adding a substring match", () => {
    expect(globToLike("Q? Report*")).toBe("Q_ Report%");
  });
});

describe("orderClause", () => {
  const map = { title: "lower(title)", updated_at: "updated_at" };

  it("falls back for a key the map does not own", () => {
    expect(orderClause(map, "title", "updated_at", "asc", "desc")).toBe("lower(title) ASC");
    expect(orderClause(map, "toString", "updated_at", undefined, "desc")).toBe("updated_at DESC");
    expect(orderClause(map, "1; DROP TABLE docs", "updated_at", undefined, "desc")).toBe("updated_at DESC");
  });
});
