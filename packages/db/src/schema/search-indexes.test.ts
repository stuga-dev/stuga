import { describe, expect, it } from "vitest";
import { preloadsPgSearch } from "./search-indexes.js";

describe("preloadsPgSearch", () => {
  it("finds the library written plainly, padded, quoted, as a path or with a suffix", () => {
    for (const setting of ["pg_search", "  pg_search ", "pg_search.so", "$libdir/pg_search.dylib", "'pg_search'", '"pg_search"', "'$libdir/pg_search'"]) {
      expect(preloadsPgSearch(setting), setting).toBe(true);
    }
  });

  it("finds it among other libraries", () => {
    expect(preloadsPgSearch("pg_stat_statements, pg_search,auto_explain")).toBe(true);
    expect(preloadsPgSearch('pg_stat_statements, "$libdir/pg_search"')).toBe(true);
  });

  it("does not match a library that is absent or only similarly named", () => {
    for (const setting of ["pg_stat_statements,auto_explain", "pg_search_extra", "pg_search/other", ""]) {
      expect(preloadsPgSearch(setting), setting).toBe(false);
    }
  });
});
