import { describe, expect, it } from "vitest";
import { CHANGE_TITLE_MAX, changeCardPath, cleanChangeText, isChangeId, newChangeId } from "./changes";

describe("changes", () => {
  it("mints ids of one shape, and knows them", () => {
    const id = newChangeId();
    expect(id).toMatch(/^chg_[0-9a-f]{12}$/);
    expect(isChangeId(id)).toBe(true);
    expect(isChangeId("run_0123456789ab")).toBe(false);
    expect(isChangeId("chg_../../etc")).toBe(false);
    expect(isChangeId(42)).toBe(false);
  });

  it("keeps a title on one line, without control characters, cut to its limit", () => {
    expect(cleanChangeText("  Customer sync,\n 2026-10-21\u0007 ", CHANGE_TITLE_MAX, true)).toBe("Customer sync, 2026-10-21");
    expect(cleanChangeText("x".repeat(CHANGE_TITLE_MAX + 5), CHANGE_TITLE_MAX, true)).toHaveLength(CHANGE_TITLE_MAX);
    expect(cleanChangeText(7, CHANGE_TITLE_MAX, true)).toBe("");
  });

  it("keeps a summary's paragraphs", () => {
    expect(cleanChangeText("Adds Initech.\n\n\n\nRaises  Acme's window.", 2000, false)).toBe("Adds Initech.\n\nRaises Acme's window.");
  });

  it("links the card, in the change's workspace when asked", () => {
    expect(changeCardPath("chg_0123456789ab")).toBe("/review/change/chg_0123456789ab");
    expect(changeCardPath("chg_0123456789ab", "ws 1")).toBe("/review/change/chg_0123456789ab?workspace=ws%201");
  });
});
