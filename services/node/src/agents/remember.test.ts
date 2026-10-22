import { describe, expect, it } from "vitest";
import { excerptOf, sectionOf } from "./remember.js";

describe("a place's excerpt", () => {
  it("is the passage without its heading, whole when it is short", () => {
    expect(excerptOf("## Approval\n\nRefunds over 500 euros need finance approval.", ["refunds"])).toBe("Refunds over 500 euros need finance approval.");
  });

  it("is the stretch around the first word it shares with the point, cut at word breaks", () => {
    const text = `${"Opening words go here. ".repeat(20)}Refunds over 500 euros need finance approval. ${"Closing words go here. ".repeat(20)}`;
    const excerpt = excerptOf(text, ["finance"], 80);
    expect(excerpt).toMatch(/^…/);
    expect(excerpt).toMatch(/…$/);
    expect(excerpt).toContain("finance approval");
    expect(excerpt.length).toBeLessThanOrEqual(82);
    expect(excerptOf(text, ["nowhere"], 40).startsWith("Opening words")).toBe(true);
  });
});

describe("a place's section", () => {
  it("is the last heading of its path, never the page's title heading", () => {
    expect(sectionOf({ heading_path: "新员工须知 > 办公室", content: "## 办公室\n\n- 前台 9 点开门。" })).toBe("办公室");
    expect(sectionOf({ heading_path: "Acme", content: "# Acme\n\nA logistics company." })).toBeNull();
    // A page that starts at its second level has sections, not a title heading.
    expect(sectionOf({ heading_path: "Contacts", content: "## Contacts\n\n- Jonas Weber." })).toBe("Contacts");
    expect(sectionOf({ heading_path: null, content: "Text before any heading." })).toBeNull();
  });
});
