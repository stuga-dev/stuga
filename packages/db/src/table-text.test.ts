/** What Save to Stuga and Ask Stuga read in a table's rows, as search normalises text. */
import { describe, expect, it } from "vitest";
import { cellSaid, holdsValue, longestNames, namedChoice, namesColumn, namesRow, questionWords, saysCell, wordsInCell } from "./table-text.js";

describe("a row a point names", () => {
  it("is named by its title cell's value as written, whatever its case or width", () => {
    expect(namesRow("Initech's contact is Ana Ruiz.", "Initech")).toBe(true);
    expect(namesRow("INITECH moved to the Team plan.", "Initech")).toBe(true);
    expect(namesRow("Ｉｎｉｔｅｃｈ moved to the Team plan.", "Initech")).toBe(true);
    expect(namesRow("Initech's contact is Ana Ruiz.", "ＩＮＩＴＥＣＨ")).toBe(true);
    // A word that holds the name is another word.
    expect(namesRow("Initechs and others", "Initech")).toBe(false);
    expect(namesRow("Globex Corp pays late.", "Globex Corp")).toBe(true);
    expect(namesRow("Globex pays late.", "Globex Corp")).toBe(false);
  });

  it("reads traditional Chinese as simplified, and finds a name inside a sentence written without spaces", () => {
    expect(namesRow("環球公司的聯絡人是安娜", "环球公司")).toBe(true);
    expect(namesRow("环球公司的联系人是安娜", "環球公司")).toBe(true);
    expect(namesRow("环球公司的联系人是安娜", "东方公司")).toBe(false);
  });

  it("is never named by a title of one character, or of no letter", () => {
    expect(namesRow("A new customer", "A")).toBe(false);
    expect(namesRow("Order 2026 shipped", "2026")).toBe(false);
  });

  it("keeps the longest of the names a point names", () => {
    expect(longestNames(["Initech", "Initech Labs", "Globex"])).toEqual(["Initech Labs", "Globex"]);
    expect(longestNames(["Initech", "INITECH"])).toEqual(["Initech", "INITECH"]);
  });
});

describe("a column a point names", () => {
  it("is named by every word of its name, the same or with another ending", () => {
    expect(namesColumn("Initech's refund window is 30 days", "Refund window")).toBe(true);
    expect(namesColumn("Initech's refund is 30 days", "Refund window")).toBe(false);
    expect(namesColumn("Initech's contact is Ana", "Contact")).toBe(true);
    expect(namesColumn("both are on paid plans", "Plan")).toBe(true);
  });

  it("is named by a choice it offers, as written, the longest first", () => {
    expect(namedChoice("new customer Hooli on the Pro plan", ["Free", "Pro", "Team"])).toBe("Pro");
    expect(namedChoice("the pros and cons", ["Free", "Pro", "Team"])).toBeNull();
    expect(namedChoice("moved to Pro Plus", ["Pro", "Pro Plus"])).toBe("Pro Plus");
    // A choice the point says no longer holds is not the one it says.
    expect(namedChoice("Globex is on the Team plan, not Pro", ["Free", "Pro", "Team"])).toBe("Team");
    expect(namedChoice("Globex moved from Pro to Team", ["Free", "Pro", "Team"])).toBe("Team");
    expect(namedChoice("Pro or Team, nobody knows", ["Free", "Pro", "Team"])).toBeNull();
  });
});

describe("a cell a point says", () => {
  it("says its value as written, a number included, and nothing else", () => {
    expect(saysCell("Initech's refund window is 30 days", "30 days")).toBe(true);
    expect(saysCell("Initech's refund window is 30 days", "30")).toBe(true);
    expect(saysCell("Initech's refund window is 30 days", "14 days")).toBe(false);
    expect(saysCell("Initech's contact is ana ruiz", "Ana Ruiz")).toBe(true);
    expect(saysCell("Initech's contact is Ana Ruiz", "Ana Ruiz, finance")).toBe(false);
    // What the point says no longer holds is not what it says.
    expect(saysCell("Initech's contact is Ana Ruiz, not Bo Chen", "Bo Chen")).toBe(false);
    expect(saysCell("Initech's contact is no longer Bo Chen", "Bo Chen")).toBe(false);
    expect(saysCell("Initech's contact is Ana Ruiz, not Bo Chen", "Ana Ruiz")).toBe(true);
    expect(saysCell("Initech's refund window went from 14 days to 30 days", "14 days")).toBe(false);
    expect(saysCell("Initech's refund window went from 14 days to 30 days", "30 days")).toBe(true);
    expect(saysCell("环球的套餐是团队版，不是专业版", "专业版")).toBe(false);
    expect(saysCell("环球的套餐是团队版，不是专业版", "团队版")).toBe(true);
    expect(holdsValue("Order 2026", "2026")).toBe(false);
  });

  it("says a cell holds what it holds only when nothing in the point says another value for it", () => {
    const point = "Acme's refund window is 30 days. It was previously recorded as 14 days; 30 days is the correct figure.";
    expect(cellSaid(point, "14 days", ["Acme", "Refund window"])).toBe(false);
    expect(cellSaid(point, "30 days", ["Acme", "Refund window"])).toBe(true);
    expect(cellSaid("Acme's refund window went from 14 days to 30 days.", "14 days")).toBe(false);
    expect(cellSaid("Acme's refund window is 30 days, not 14 days.", "30 days")).toBe(true);
    // A name beside another name may be the old one.
    expect(cellSaid("Ana Ruiz is Initech's contact.", "Ana Ruiz", ["Initech", "Contact"])).toBe(true);
    expect(cellSaid("Ana Ruiz is Initech's contact; Bo Chen moved to finance.", "Bo Chen", ["Initech", "Contact"])).toBe(false);
    expect(cellSaid("Initech's contact is Ana Ruiz.", "Bo Chen", ["Initech", "Contact"])).toBe(false);
    expect(holdsValue("Order 2026", "2026", { numbers: true })).toBe(true);
  });
});

describe("the words of a question a row holds", () => {
  it("reads words of two letters or more, numbers of three digits or more, and pairs of characters", () => {
    expect(questionWords("Who is Globex's contact?")).toEqual(["who", "is", "globex", "contact"]);
    expect(questionWords("order ORD-00777, 2 items")).toEqual(["order", "ord", "00777", "items"]);
    expect(questionWords("環球的聯絡人")).toEqual(["环球", "球的", "的联", "联络", "络人"]);
  });

  it("holds a word as written or with another ending, never one inside another", () => {
    expect(wordsInCell(["globex", "contact"], "Globex")).toEqual(["globex"]);
    expect(wordsInCell(["customers", "pro"], "Pro")).toEqual(["pro"]);
    expect(wordsInCell(["refund"], "Refunds go out monthly")).toEqual(["refund"]);
    expect(wordsInCell(["pro"], "Professional")).toEqual([]);
    expect(wordsInCell(["联络"], "環球的聯絡人")).toEqual(["联络"]);
  });
});
