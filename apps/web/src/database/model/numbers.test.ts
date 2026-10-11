import { describe, expect, it } from "vitest";
import { formatNumber, numberForEditing, parseNumberText } from "./numbers";

const value = (raw: string, locale = "en") => {
  const r = parseNumberText(raw, locale);
  return r.ok ? r.value : r.reason;
};

describe("parseNumberText", () => {
  it("reads plain, signed, grouped and exponent numbers", () => {
    expect(value("1200.50")).toBe(1200.5);
    expect(value("-3")).toBe(-3);
    expect(value("+0.25")).toBe(0.25);
    expect(value(".5")).toBe(0.5);
    expect(value("1,234,567.891")).toBe(1234567.891);
    expect(value("1 000")).toBe(1000);
    expect(value("1e3")).toBe(1000);
    expect(value("-0")).toBe(0);
  });

  it("never turns a decimal comma into thousands", () => {
    expect(value("4,50")).toBe(4.5);
    expect(value("$4,50")).toBe(4.5);
    expect(value("4,50", "de")).toBe(4.5);
    expect(value("1,5")).toBe(1.5);
    expect(value("1,0000")).toBe(1);
  });

  it("reads the separator the locale groups with as thousands, and its own decimal sign as decimal", () => {
    expect(value("1,000")).toBe(1000);
    expect(value("1.000")).toBe(1);
    expect(value("1.000", "de")).toBe(1000);
    expect(value("1,000", "de")).toBe(1);
    expect(value("1.234,5", "de")).toBe(1234.5);
    expect(value("1 234,5", "fr")).toBe(1234.5);
  });

  it("takes a currency or percent sign as decoration", () => {
    expect(value("€12")).toBe(12);
    expect(value("-$5")).toBe(-5);
    expect(value("$-5")).toBe(-5);
    expect(value("12 €", "de")).toBe(12);
    expect(value("25%")).toBe(25);
  });

  it("refuses junk instead of reading part of it", () => {
    expect(value("abc")).toBe("not_a_number");
    expect(value("1.2.3")).toBe("not_a_number");
    expect(value("12abc")).toBe("not_a_number");
    expect(value("1,000,5")).toBe("not_a_number");
    expect(value("--1")).toBe("not_a_number");
    expect(value(".")).toBe("not_a_number");
  });

  it("refuses a whole number past 2^53 rather than store a neighbour of it", () => {
    expect(value("12345678901234567890")).toBe("too_large");
    expect(value("9007199254740991")).toBe(9007199254740991);
    expect(value("9007199254740993")).toBe("too_large");
  });
});

describe("formatNumber", () => {
  it("shows every digit, ungrouped, by default", () => {
    expect(formatNumber(1200.5, undefined, "en")).toBe("1200.5");
    expect(formatNumber(4.5, undefined, "de")).toBe("4,5");
  });

  it("applies decimals, grouping, currency and percent", () => {
    expect(formatNumber(1200.5, { style: "number", decimals: 2, grouping: true }, "en")).toBe("1,200.50");
    expect(formatNumber(4.5, { style: "currency", currency: "EUR", decimals: 2 }, "en")).toBe("€4.50");
    expect(formatNumber(1234.5, { style: "currency", currency: "EUR", grouping: true }, "de")).toBe("1.234,50\u00A0€");
    expect(formatNumber(25, { style: "percent" }, "en")).toBe("25%");
    expect(formatNumber(33.3, { style: "percent" }, "en")).toBe("33.3%");
  });

  it("gives the editor a value that reads back as the same number", () => {
    for (const [n, locale] of [[1234567.891, "en"], [0.1, "de"], [-42, "fr"], [12345678901234, "en"]] as const) {
      const r = parseNumberText(numberForEditing(n, locale), locale);
      expect(r).toEqual({ ok: true, value: n });
    }
  });
});
