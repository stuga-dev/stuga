import { describe, expect, it } from "vitest";
import {
  alikeSentences,
  comparableText,
  headingsOnly,
  holdsPoint,
  namesTitle,
  openingHeadingLevel,
  possessiveNames,
  properNouns,
  readsAsName,
  savedSentences,
  sentencesOf,
  sharedWords,
  withoutAddresses,
} from "./remember-text.js";

describe("already there", () => {
  it("finds the point's words in their order, whatever the Markdown, case, width or script around them", () => {
    const doc = "## Refunds\n\n- **Refunds** over 500 euros need [finance](https://x.test/f) approval.\n- Sam signs off.";
    expect(holdsPoint(doc, "Refunds over 500 euros need finance approval")).toBe(true);
    expect(holdsPoint(doc, "refunds over 500 EUROS need finance approval.")).toBe(true);
    expect(holdsPoint(doc, "Ｒｅｆｕｎｄｓ over 500 euros need finance approval")).toBe(true);
    expect(holdsPoint(doc, "Refunds over 300 euros need finance approval")).toBe(false);
  });

  it("holds whole words only, where the script has words", () => {
    expect(holdsPoint("We reuse pnpm everywhere", "use pnpm")).toBe(false);
    expect(holdsPoint("We use pnpm everywhere", "use pnpm")).toBe(true);
  });

  it("reads Chinese with or without spaces around a number, and traditional as simplified", () => {
    expect(holdsPoint("年会预算定为每人 300 元。", "年会预算定为每人300元")).toBe(true);
    expect(holdsPoint("年會預算定為每人300元", "年会预算定为每人300元")).toBe(true);
    expect(holdsPoint("年会预算定为每人300元", "每人300元")).toBe(true);
    expect(comparableText("每人 300 元")).toBe("每人300元");
  });

  it("finds nothing for a point of no words, or of numbers and dates alone", () => {
    expect(holdsPoint("anything", "—")).toBe(false);
    expect(holdsPoint("Said by the user on 2026-10-22.", "2026-10-22")).toBe(false);
  });

  it("is decided sentence by sentence: a question, a struck-through sentence or a denial does not say the point", () => {
    const point = "Refunds over 500 euros need finance approval.";
    expect(holdsPoint("## FAQ\n\nDo refunds over 500 euros need finance approval? No: since March only refunds over 2000 euros do.", point)).toBe(false);
    expect(holdsPoint("- ~~Refunds over 500 euros need finance approval.~~ Replaced by the 2000 euro rule.", point)).toBe(false);
    expect(holdsPoint("- <del>Refunds over 500 euros need finance approval.</del> Replaced by the 2000 euro rule.", point)).toBe(false);
    expect(holdsPoint("It is no longer true that refunds over 500 euros need finance approval.", point)).toBe(false);
    expect(holdsPoint("Refunds over 500 euros don't need finance approval any more.", "Refunds over 500 euros need finance approval")).toBe(false);
    expect(holdsPoint("超过 500 欧元的退款不再需要财务审批。", "超过 500 欧元的退款需要财务审批")).toBe(false);
    // A point that denies is said by a sentence that denies.
    expect(holdsPoint("Refunds are not taxed.", "Refunds are not taxed")).toBe(true);
    // One sentence says it, beside a question that does not.
    expect(savedSentences("Do refunds need approval? Refunds over 500 euros need finance approval.", point)).toEqual([
      "Refunds over 500 euros need finance approval.",
    ]);
  });

  it("needs every sentence of a point said, each by a sentence that states it", () => {
    const page = "Refunds over 500 euros need finance approval. Sam keeps the refund log.";
    expect(savedSentences(page, "Sam keeps the refund log. Refunds over 500 euros need finance approval.")).toEqual([
      "Sam keeps the refund log.",
      "Refunds over 500 euros need finance approval.",
    ]);
    expect(savedSentences(page, "Refunds over 500 euros need finance approval. Liv answers on Mondays.")).toBeNull();
  });
});

describe("sentences", () => {
  it("are the claims of a passage as written, without headings, code or list markers", () => {
    const md = "# Support\n\n- Tickets get a first reply within one working day. Weekends do not count.\n\n```\nnot.a = sentence;\n```\n> 1. Escalate to Sam after two days\n退款需要财务审批。发票写公司全称。";
    expect(sentencesOf(md)).toEqual([
      "Tickets get a first reply within one working day.",
      "Weekends do not count.",
      "Escalate to Sam after two days",
      "退款需要财务审批。",
      "发票写公司全称。",
    ]);
  });
});

describe("sentences a point may make untrue", () => {
  const passage = "## Refunds\n\nRefunds over 500 euros need finance approval. Liv answers refund questions on Mondays.";

  it("names the sentence a new figure would replace, and leaves the rest", () => {
    const found = alikeSentences("Refunds over 300 euros need finance approval", passage);
    expect(found).toEqual([expect.objectContaining({ sentence: "Refunds over 500 euros need finance approval.", hint: "possibly_replaces" })]);
  });

  it("calls a sentence the point repeats a likely duplicate", () => {
    const found = alikeSentences("Refunds over 500 euros need finance approval. Sam keeps the log.", passage);
    expect(found[0]).toMatchObject({ sentence: "Refunds over 500 euros need finance approval.", hint: "likely_duplicate" });
  });

  it("names nothing for a point about something else", () => {
    expect(alikeSentences("The office moves to the river building in April", passage)).toEqual([]);
  });

  it("calls a sentence the point holds a likely duplicate even when the point adds a figure", () => {
    const found = alikeSentences("Refunds over 500 euros need finance approval, and Sam logs each one within 2 days.", passage);
    expect(found[0]).toMatchObject({ sentence: "Refunds over 500 euros need finance approval.", hint: "likely_duplicate" });
  });

  it("calls a sentence with the point's figures in other words a likely duplicate", () => {
    const found = alikeSentences("Acme pays our invoices within 30 days (net 30).", "## Contract\n\n- Annual contract that renews on 1 March.\n- Invoices are paid net 30.");
    expect(found).toEqual([expect.objectContaining({ sentence: "Invoices are paid net 30.", hint: "likely_duplicate" })]);
  });

  it("offers a question, a denial and a struck-through rule as what the point may change, never as duplicates", () => {
    const point = "Refunds over 500 euros need finance approval.";
    expect(alikeSentences(point, "Do refunds over 500 euros need finance approval? No: since March only refunds over 2000 euros do.")[0]).toMatchObject({
      sentence: "Do refunds over 500 euros need finance approval?",
      hint: "possibly_replaces",
    });
    expect(alikeSentences(point, "It is no longer true that refunds over 500 euros need finance approval.")).toEqual([
      expect.objectContaining({ hint: "possibly_replaces" }),
    ]);
    // Struck through, it is gone already: only what stands beside it is compared.
    expect(alikeSentences(point, "- ~~Refunds over 500 euros need finance approval.~~ Replaced by the 2000 euro rule.")).toEqual([]);
  });

  it("never matches on numbers or dates alone", () => {
    expect(alikeSentences("Acme pays our invoices within 30 days. Noted on 2026-10-22.", "* Prefers British spelling. Said by the user on 2026-10-22.")).toEqual([]);
    expect(alikeSentences("Invoice 4471 is due on 2026-10-22.", "Released on 2026-10-22.")).toEqual([]);
  });

  it("offers a Chinese correction of a time as what it replaces", () => {
    const found = alikeSentences("上海办公室前台现在早上 8 点半开门。", "## 办公室\n\n* 上海办公室在静安区，前台早上 9 点开门。");
    expect(found).toEqual([expect.objectContaining({ sentence: "上海办公室在静安区，前台早上 9 点开门。", hint: "possibly_replaces" })]);
    expect(alikeSentences("前台早上 8:30 开门", "* 上海办公室在静安区，前台早上 9 点开门。")).toEqual([
      expect.objectContaining({ hint: "possibly_replaces" }),
    ]);
  });
});

describe("shared words", () => {
  it("names the point's words a passage holds, a word with another ending too", () => {
    expect(sharedWords("Refunds over 500 euros need finance approval", "## Refund rules\n\nFinance approves every refund.")).toEqual(["refunds", "finance"]);
    expect(sharedWords("年会预算", "年会在河边酒店")).toEqual(["年会"]);
    expect(sharedWords("Office moves in April", "Refund rules")).toEqual([]);
    expect(sharedWords("A new policy on parental leave", "Policies")).toEqual(["policy"]);
    expect(sharedWords("Acme pays its invoices", "Invoices are paid net 30.")).toEqual(["invoices"]);
  });

  it("matches a heading by the same word only when asked to, never by another form of it", () => {
    expect(sharedWords("Globex account", "Accounts")).toEqual(["account"]);
    expect(sharedWords("Globex account", "Accounts", 6, true)).toEqual([]);
    expect(sharedWords("Initech contract", "Contract", 6, true)).toEqual(["contract"]);
    expect(sharedWords("上海办公室快递", "办公室", 6, true)).toEqual(["办公", "公室"]);
  });
});

describe("what a plan reads of a point and a page", () => {
  it("leaves addresses out of a point's words: where to send something says nothing of what it is about", () => {
    expect(withoutAddresses("Globex wants invoices sent to ap@globex.example.")).toBe("Globex wants invoices sent to  .");
    expect(sharedWords(withoutAddresses("Invoices go to ap@globex.example"), "Book through travel@northwind.example.")).toEqual([]);
    expect(withoutAddresses("See https://x.test/a?b=1 and www.example.org/c.")).toBe("See   and  .");
  });

  it("tells a passage of headings alone, and a title heading, from one with text", () => {
    expect(headingsOnly("# Refunds")).toBe(true);
    expect(headingsOnly("## Rules\n\n### Hotels\n")).toBe(true);
    expect(headingsOnly("## Rules\n\n- Book trains.")).toBe(false);
    expect(openingHeadingLevel("# Acme\n\nA customer.")).toBe(1);
    expect(openingHeadingLevel("## Contract\n\n- Net 30.")).toBe(2);
    expect(openingHeadingLevel("Acme is a customer.")).toBeNull();
  });

  it("finds proper nouns: a capital that does not open a sentence, or a possessive anywhere; never a month or a day", () => {
    expect([...properNouns("Initech's contract starts on 1 November 2026.")]).toEqual(["initech"]);
    expect([...properNouns("Agreed with Jonas Weber of Acme on Monday.")].sort()).toEqual(["acme", "jonas", "weber"]);
    expect([...properNouns("Refunds go back to the original payment method.")]).toEqual([]);
    expect([...properNouns("- Hotels cost at most €150 a night in Europe.")]).toEqual(["europe"]);
    expect([...properNouns("前台早上 9 点开门。")]).toEqual([]);
    expect([...possessiveNames("Globex’s refund window is 7 days; each customer's is on their page.")]).toEqual(["globex"]);
  });

  it("names a page by every word of its title, the same or with another ending", () => {
    expect(namesTitle("Initech's invoices are paid net 45.", "Initech")).toBe(true);
    expect(namesTitle("Refund policy", "Refunds")).toBe(true);
    expect(namesTitle("The first week of a new hire", "First week")).toBe(true);
    expect(namesTitle("The first day", "First week")).toBe(false);
    expect(namesTitle("新同事第一周看新员工须知", "新员工须知")).toBe(true);
    expect(namesTitle("新人入职", "新员工须知")).toBe(false);
  });

  it("reads a title as a name only when it is never written in lower case, in any form", () => {
    const texts = ["Initech invoices are paid net 45.", "Initech contract", "- The refund window is 14 days from delivery."];
    expect(readsAsName("Initech", texts)).toBe(true);
    expect(readsAsName("Refunds", ["Acme refunds", ...texts])).toBe(false);
    expect(readsAsName("Refunds", ["Refunds", "- Each customer's refund window is on their page."])).toBe(false);
    expect(readsAsName("Travel", ["Travel expenses", "- Book through the travel desk."])).toBe(false);
    // Not written at all, or in a script without capitals: no name.
    expect(readsAsName("Globex", texts)).toBe(false);
    expect(readsAsName("新员工须知", ["新员工须知"])).toBe(false);
  });
});
