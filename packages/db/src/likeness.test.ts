import { describe, expect, it } from "vitest";
import {
  LIKELY_DUPLICATE,
  REPLACE_HINT_OVERLAP,
  estimateJaccard,
  foldText,
  hashText,
  jaccard,
  minhash,
  numbersDiffer,
  replaceHint,
  shingles,
  sketch,
  textLikeness,
} from "./likeness.js";

describe("folding", () => {
  it("keeps superscript, subscript and circled digits apart from plain ones", () => {
    expect(foldText("Budget 10⁶")).not.toBe(foldText("Budget 106"));
    expect(foldText("H₂O")).not.toBe(foldText("H2O"));
    expect(hashText("Ｂｕｄｇｅｔ １０⁶")).toBe(hashText("budget 10⁶"));
    expect(numbersDiffer("Budget 10⁶", "Budget 106")).toBe(true);
  });

  it("hashes a hyphen between letters away, and a minus never", () => {
    expect(hashText("Labels are re-printed")).toBe(hashText("labels are reprinted"));
    expect(hashText("at -5 degrees")).not.toBe(hashText("at 5 degrees"));
  });

  it("is NFKC, case folded, one dash, one space", () => {
    expect(foldText("  Ｔｉｃｋｅｔｓ   GET a reply—within  a day ")).toBe("tickets get a reply-within a day");
    expect(foldText("expand – contract")).toBe("expand-contract");
    expect(foldText("Straße")).toBe(foldText("STRASSE"));
    expect(foldText("ｶﾀｶﾅ")).toBe("カタカナ");
  });

  it("reads numbers as runs of digits, leading zeros aside", () => {
    expect(numbersDiffer("budget 300", "budget 350")).toBe(true);
    expect(numbersDiffer("ADR 0011", "ADR 11")).toBe(false);
    expect(numbersDiffer("no number", "none here")).toBe(false);
    expect(numbersDiffer("Q3", "Q3 report")).toBe(false);
  });
});

/**
 * The calibration REPLACE_HINT_OVERLAP rests on: corrections and updates of one point, and other
 * points of the same topic, in English and Chinese.
 */
const UPDATES: Array<[string, string]> = [
  ["Annual party budget is 300 euros\nThe team agreed on 300 euros a head.", "Annual party budget is 350 euros\nThe team raised it to 350 euros a head."],
  ["年会预算 300 元\n年会预算定为每人 300 元。", "年会预算改为 350 元\n年会预算从每人 300 元改成每人 350 元。"],
  ["Tickets get a first reply within a day", "Tickets get a first reply within four hours"],
  ["Support replies to tickets within one business day\nApplies to all paid plans.", "Support replies to tickets within one business day\nApplies to all plans, free included."],
  ["Deploys freeze on Fridays\nNo production deploys after 12:00 on Fridays.", "Deploys freeze on Fridays from 15:00\nNo production deploys after 15:00 on Fridays."],
  ["报销需要部门经理审批", "报销需要部门经理和财务审批"],
  ["Sam prefers email over calls", "Sam prefers calls over email"],
  ["Office moves to Shanghai Pudong in March", "Office moves to Shanghai Pudong in April"],
  ["The Q3 report is due on 10 October", "The Q3 report is due on 17 October"],
  ["Use Postgres 16 for new services", "Use Postgres 17 for new services"],
  ["Tickets get a first reply within one working day", "First replies to support tickets go out within four working hours from November"],
];
const OTHERS: Array<[string, string]> = [
  ["Annual party budget is 300 euros", "Annual party is at the river hotel"],
  ["年会预算 300 元", "年会在河边酒店举行"],
  ["Tickets get a first reply within a day", "Refunds over 500 euros need finance approval"],
  ["Deploys freeze on Fridays", "Staging resets every Monday night"],
  ["报销需要部门经理审批", "发票抬头写公司全称"],
  ["Sam prefers email over calls", "Sam is the buyer at Acme"],
  ["Office moves to Shanghai Pudong in March", "The Beijing office keeps its lease"],
  ["The Q3 report is due on 10 October", "The Q3 report covers EMEA only"],
  ["Use Postgres 16 for new services", "Use expand-contract for schema migrations"],
  ["Support replies within one business day", "Support works in two shifts"],
  // Two points of one meeting's notes that share only their framing.
  ["The support queue moves to the new help desk on 20 October", "Liv runs the next support review on 30 October"],
];

describe("text likeness", () => {
  it("hints that an update may replace what it updates, and stays quiet for other points, at the calibrated threshold", () => {
    for (const [a, b] of UPDATES) expect(replaceHint(textLikeness(sketch(a), sketch(b))), b).not.toBeNull();
    for (const [a, b] of OTHERS) expect(replaceHint(textLikeness(sketch(a), sketch(b))), b).toBeNull();
    const overlap = (pairs: Array<[string, string]>) => pairs.map(([a, b]) => textLikeness(sketch(a), sketch(b)).overlap);
    expect(Math.min(...overlap(UPDATES))).toBeGreaterThanOrEqual(REPLACE_HINT_OVERLAP);
  });

  it("calls the same point written again a likely duplicate, but never two that name different numbers", () => {
    const a = sketch("Tickets get a first reply within one working day");
    expect(replaceHint(textLikeness(a, sketch("Tickets get a first reply within one working day.")))).toBe("likely_duplicate");
    const budget = textLikeness(sketch("The budget is 300 euros a head"), sketch("The budget is 350 euros a head"));
    expect(budget.jaccard).toBeGreaterThanOrEqual(LIKELY_DUPLICATE);
    expect(budget.numbersDiffer).toBe(true);
    expect(replaceHint(budget)).toBe("possibly_replaces");
  });

  it("estimates the shingles' Jaccard by MinHash, deterministically", () => {
    const a = shingles("Every ticket gets a first reply within one working day, paid plans included.");
    const b = shingles("Every ticket gets a first reply within four working hours, paid plans included.");
    const estimate = estimateJaccard(minhash(a), minhash(b));
    expect(Math.abs(estimate - jaccard(a, b))).toBeLessThan(0.1);
    expect(estimateJaccard(minhash(a), minhash(a))).toBe(1);
    expect([...minhash(a)]).toEqual([...minhash(new Set(a))]);
  });
});
