import { describe, expect, it } from "vitest";
import { MAX_QUERY_TERMS, MAX_TERM_CHARS, SEARCH_FORMAT, normalizeText, queryShape, queryTerms, searchParts, searchTokens } from "./search-text.js";

describe("normalizeText", () => {
  it("turns full-width into half-width, traditional Chinese into simplified, and folds case", () => {
    expect(normalizeText("ＡＢＣ１２３，Ｐｏｓｔｇｒｅｓ")).toBe("abc123,postgres");
    expect(normalizeText("報銷發票審批人")).toBe("报销发票审批人");
    // Half-width katakana becomes the full-width kind every other text uses.
    expect(normalizeText("ｶﾀｶﾅ")).toBe("カタカナ");
  });
});

describe("searchParts", () => {
  it("spells a Chinese run as its characters, then its pairs in order", () => {
    expect(searchParts("审批人")).toEqual({ latin: "", cjk: "审 批 人 审批 批人" });
  });

  it("keeps Latin words apart from the CJK they touch, cut at punctuation", () => {
    const parts = searchParts("生产库用expand-contract迁移");
    expect(parts.latin).toBe("expand contract");
    expect(parts.cjk).toContain("生产 产库");
    expect(parts.cjk).toContain("迁移");
  });

  it("treats kana as Han's neighbours, and Hangul in pairs too", () => {
    expect(searchParts("設立した").cjk).toBe("设 立 し た 设立 立し した");
    expect(searchParts("불가리아의").cjk).toBe("불 가 리 아 의 불가 가리 리아 아의");
  });

  it("writes Thai as its words", () => {
    expect(searchParts("แกะโคลนตัวแรก").cjk.split(" ")).toEqual(["แกะ", "โคลน", "ตัว", "แรก"]);
  });

  it("drops accents and keeps other spaced scripts as words", () => {
    expect(searchParts("Café au lait — مرحبا").latin).toBe("cafe au lait مرحبا");
    expect(searchParts("Node.js 22").latin).toBe("node js 22");
  });

  it("names the ICU build its Thai words come from", () => {
    expect(SEARCH_FORMAT).toMatch(/^\d+\/icu-/);
  });
});

describe("queryTerms", () => {
  it("cuts at spaces and script changes, and searches a two-character piece by its pair alone", () => {
    expect(queryTerms("报销 发票 审批人")).toEqual({ latin: [], cjk: ["报销", "发票", "审批", "批人", "审", "批", "人"] });
  });

  it("spells Latin pieces as the index does", () => {
    expect(queryTerms("生产库 expand-contract 迁移")).toEqual({
      latin: ["expand", "contract"],
      cjk: ["生产", "产库", "生", "产", "库", "迁移"],
    });
  });

  it("finds traditional, full-width and accented queries in the folded index", () => {
    expect(queryTerms("審批").cjk).toEqual(["审批"]);
    expect(queryTerms("ＰＯＳＴＧＲＥＳ").latin).toEqual(["postgres"]);
    expect(queryTerms("café").latin).toEqual(["cafe"]);
  });

  it("asks nothing of a query with no word in it, and bounds a long one", () => {
    expect(queryTerms("  ？！… ")).toEqual({ latin: [], cjk: [] });
    const long = queryTerms(Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(""));
    expect(long.latin.length + long.cjk.length).toBe(MAX_QUERY_TERMS);
  });
});

describe("searchTokens", () => {
  /** Each token as `part term → the text it was read from`. */
  const read = (text: string) => [...searchTokens(text)].map((t) => `${t.part} ${t.term} → ${text.slice(t.start, t.end)}`);

  it("says where in the text each word was read, as written", () => {
    expect(read("Ｃafé, Node.js")).toEqual(["latin cafe → Ｃafé", "latin node → Node", "latin js → js"]);
  });

  it("says where each character and pair was read, traditional or not", () => {
    expect(read("報銷了")).toEqual([
      "cjk 报 → 報",
      "cjk 销 → 銷",
      "cjk 了 → 了",
      "cjk 报销 → 報銷",
      "cjk 销了 → 銷了",
    ]);
  });

  it("says where each Thai word was read", () => {
    expect(read("แกะโคลน ok")).toEqual(["cjk แกะ → แกะ", "cjk โคลน → โคลน", "latin ok → ok"]);
  });

  it("gives a run that normalising changes in length the whole run", () => {
    // Half-width ka and its voicing mark are one character, ga, once normalised.
    expect(read("ｶﾞｷ")).toEqual(["cjk ガ → ｶﾞｷ", "cjk キ → ｶﾞｷ", "cjk ガキ → ｶﾞｷ"]);
  });

  it("writes the terms searchParts writes, in its order", () => {
    const text = "生产库用expand-contract迁移 and 審批人";
    const tokens = [...searchTokens(text)];
    expect(searchParts(text)).toEqual({
      latin: tokens.filter((t) => t.part === "latin").map((t) => t.term).join(" "),
      cjk: tokens.filter((t) => t.part === "cjk").map((t) => t.term).join(" "),
    });
  });

  it("leaves out a word too long to be one", () => {
    expect(searchParts(`short ${"x".repeat(MAX_TERM_CHARS + 1)} words`).latin).toBe("short words");
  });
});

describe("Thai and Lao", () => {
  it("keeps sara am whole through NFKC, so a word holding it is read as one", () => {
    expect(normalizeText("ทำงาน")).toBe("ทำงาน");
    expect(searchParts("ผมทำงานที่บริษัทใหญ่").cjk.split(" ")).toContain("ทำงาน");
    expect(queryTerms("ทำงาน").cjk).toEqual(["ทำงาน"]);
  });
});

describe("a query and the text it is searched in", () => {
  it("are cut alike, around a symbol that normalising turns into letters", () => {
    expect(queryTerms("Acme™ widget").latin).toEqual(searchParts("Acme™ Widget").latin.split(" "));
    expect(queryTerms("№5 ℃").latin).toEqual(searchParts("№5 ℃").latin.split(" "));
  });
});

describe("queryShape", () => {
  it("asks a longer piece to hold every character in a pair, and a short one its term", () => {
    const shape = queryShape("人工智能 会");
    const groups = shape.cjkGroups.map((g) => g.map((i) => shape.cjk[i]).join("|"));
    expect(groups).toEqual(["人工", "人工|工智", "工智|智能", "智能", "会"]);
  });

  it("asks each Thai word for itself", () => {
    const shape = queryShape("แกะโคลน");
    expect(shape.cjkGroups.map((g) => g.map((i) => shape.cjk[i]))).toEqual([["แกะ"], ["โคลน"]]);
  });

  it("leaves out a group whose terms are past the query's bound", () => {
    const shape = queryShape(Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(""));
    expect(shape.cjkGroups.flat().every((i) => i < MAX_QUERY_TERMS)).toBe(true);
    expect(shape.cjkGroups.length).toBeGreaterThan(0);
  });
});
