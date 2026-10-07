import { describe, expect, it } from "vitest";
import { isSearchIndexName, preloadsPgSearch, SEARCH_LANGUAGES, searchIndexShapes } from "./search-indexes.js";

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

describe("isSearchIndexName", () => {
  it("knows every shape's name, for any languages and for a later version", () => {
    for (const languages of [[], ["ko"], ["ar"], ["ko", "ar"], SEARCH_LANGUAGES] as const) {
      for (const { name } of searchIndexShapes(languages)) expect(isSearchIndexName(name), name).toBe(true);
    }
    expect(isSearchIndexName("docs_bm25_v2_ko")).toBe(true);
  });

  it("leaves the tables' other indexes alone", () => {
    for (const name of ["docs_pkey", "docs_workspace_idx", "doc_chunks_embedding_hnsw", "bm25_docs"]) {
      expect(isSearchIndexName(name), name).toBe(false);
    }
  });
});

describe("searchIndexShapes", () => {
  const names = (languages: readonly (typeof SEARCH_LANGUAGES)[number][]) => searchIndexShapes(languages).map((i) => i.name);

  it("names the languages while the names fit", () => {
    expect(names([])).toEqual(["docs_bm25_v1", "doc_chunks_bm25_v1"]);
    expect(names(["ko", "ar"])).toEqual(["docs_bm25_v1_ar_ko", "doc_chunks_bm25_v1_ar_ko"]);
  });

  it("names a language whose tokenizer changed with its revision, so only nodes with it rebuild", () => {
    expect(names(["zh"])).toEqual(["docs_bm25_v1_zh2", "doc_chunks_bm25_v1_zh2"]);
    expect(names(["ja", "zh"])).toEqual(["docs_bm25_v1_ja_zh2", "doc_chunks_bm25_v1_ja_zh2"]);
    expect(names(["ja"])).toEqual(["docs_bm25_v1_ja", "doc_chunks_bm25_v1_ja"]);
  });

  it("keeps every name within Postgres's 63 characters, and apart for every set", () => {
    const seen = new Set<string>();
    for (let n = 1; n <= SEARCH_LANGUAGES.length; n++) {
      for (const name of names(SEARCH_LANGUAGES.slice(0, n))) {
        expect(name.length, name).toBeLessThanOrEqual(63);
        expect(seen.has(name), name).toBe(false);
        seen.add(name);
      }
    }
    expect(names([...SEARCH_LANGUAGES].reverse())).toEqual(names(SEARCH_LANGUAGES));
  });

  it("gives a language column only the text in its script", () => {
    const [docs] = searchIndexShapes(["ru"]);
    expect(docs!.definition).toContain("~ '[Ѐ-ӿ]'");
    expect(docs!.definition).toContain("pdb.icu('stemmer=russian', 'stopwords_language=russian', 'alias=all_text_ru')");
  });

  it("keeps Japanese, which is written partly in Chinese characters, out of the Chinese column", () => {
    const [docs] = searchIndexShapes(["ja", "zh"]);
    expect(docs!.definition).toContain("~ '[㐀-䶿一-鿿]' AND (title || ' ' || search_text) !~ '[ぁ-ヿ]' THEN");
    expect(docs!.definition).toContain("pdb.jieba('chinese_convert=t2s', 'alias=all_text_zh')");
    expect(docs!.definition).toContain("~ '[ぁ-ヿ]' THEN");
    expect(docs!.definition).toContain("pdb.lindera(japanese, 'alias=all_text_ja')");
  });
});
