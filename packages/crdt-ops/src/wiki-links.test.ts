/** What the wiki reads of a page's text: its links and citations with their passages, and its summary. */
import { describe, expect, it } from "vitest";
import { applyCitedStrEdits } from "./footnotes.js";
import { WIKI_SUMMARY_MAX, wikiLinkTarget, wikiText } from "./wiki-links.js";

describe("wikiLinkTarget", () => {
  it("reads the page an in-app link opens, with or without a query", () => {
    expect(wikiLinkTarget("/doc/abc123")).toBe("abc123");
    expect(wikiLinkTarget("/doc/db1?table=t1&row=r1")).toBe("db1");
    expect(wikiLinkTarget("/doc/abc#part")).toBe("abc");
  });

  it("reads a page's address at the node's own origins, as one copied from the browser", () => {
    const origins = ["https://wiki.example.com/", "https://liv.stuga.link"];
    expect(wikiLinkTarget("https://wiki.example.com/doc/abc", origins)).toBe("abc");
    expect(wikiLinkTarget("HTTPS://LIV.STUGA.LINK/doc/abc?row=1", origins)).toBe("abc");
    expect(wikiLinkTarget("https://elsewhere.example.com/doc/abc", origins)).toBeNull();
    expect(wikiText("[Policy](https://wiki.example.com/doc/p1)", { origins }).links.map((l) => l.target)).toEqual(["p1"]);
  });

  it("leaves every other address alone", () => {
    expect(wikiLinkTarget("https://example.com/doc/abc")).toBeNull();
    expect(wikiLinkTarget("/docs/abc")).toBeNull();
    expect(wikiLinkTarget("/doc/")).toBeNull();
    expect(wikiLinkTarget("mention:u_liv")).toBeNull();
    expect(wikiLinkTarget("/api/docs/abc/media/" + "0".repeat(64))).toBeNull();
  });
});

describe("wikiText", () => {
  it("finds each linked page once, with the passages that link it", () => {
    const md = "# Handbook\n\nSee [the refund policy](/doc/refunds) first.\n\n- Ask [Refunds](/doc/refunds) or [Leave](/doc/leave?x=1)\n";
    const { links } = wikiText(md);
    expect(links).toEqual([
      { target: "refunds", kind: "link", passages: ["See the refund policy first.", "Ask Refunds or Leave"] },
      { target: "leave", kind: "link", passages: ["Ask Refunds or Leave"] },
    ]);
  });

  it("reads a footnote that names a page as a citation, held by its footnote and every passage that cites it", () => {
    const md = applyCitedStrEdits(
      "# Support\n\nIntro.",
      [{ old_string: "Intro.", new_string: "Refunds take 14 days [^1].\n\nAsk the desk [^1]." }],
      [{ n: 1, doc_id: "policy", title: "Refund policy", heading_path: "Window", content: "Refunds within 14 days." }],
    );
    const { links } = wikiText(md);
    expect(links).toEqual([
      {
        target: "policy",
        kind: "citation",
        passages: ['Refund policy — Window "Refunds within 14 days."', "Refunds take 14 days.", "Ask the desk."],
      },
    ]);
  });

  it("keeps a link and a citation of the same page apart", () => {
    const md = "Read [Policy](/doc/p).\n\nIt says so [^1].\n\n[^1]: [Policy](/doc/p)\n";
    expect(wikiText(md).links.map((l) => [l.target, l.kind])).toEqual([
      ["p", "link"],
      ["p", "citation"],
    ]);
  });

  it("finds no link in code, in a web address, or in a mention", () => {
    const md = "```\n[x](/doc/incode)\n```\n\nVisit [site](https://example.com/doc/abc) and [@liv](mention:u_liv) and `[y](/doc/inline)`.\n";
    expect(wikiText(md).links).toEqual([]);
  });

  it("reads a passage again when it changes, so its text says what changed", () => {
    const before = wikiText("Owner: [Ops](/doc/ops).\n\nUnrelated line.\n").links[0]!.passages;
    const elsewhere = wikiText("Owner: [Ops](/doc/ops).\n\nAnother line.\n").links[0]!.passages;
    const around = wikiText("Owner since May: [Ops](/doc/ops).\n\nUnrelated line.\n").links[0]!.passages;
    expect(elsewhere).toEqual(before);
    expect(around).not.toEqual(before);
  });

  it("summarizes a page by its opening paragraph, never its title heading", () => {
    expect(wikiText("# Leave policy\n\nEveryone gets **25 days** a year, @-free.\n\nMore.\n").summary).toBe(
      "Everyone gets 25 days a year, @-free.",
    );
    expect(wikiText("# Only a title\n").summary).toBe("");
    expect(wikiText("").summary).toBe("");
  });

  it("names a mention by its label and drops footnote markers from a summary", () => {
    expect(wikiText("Ask [@sam](mention:u_sam) about it [^1].\n\n[^1]: [X](/doc/x)\n").summary).toBe("Ask @sam about it.");
  });

  it("falls back to a list's first paragraph when no paragraph opens the page", () => {
    expect(wikiText("# Steps\n\n- Open the door\n- Close it\n").summary).toBe("Open the door");
  });

  it("cuts a long opening at a word, within the limit", () => {
    const long = `${"Refunds are handled by the support desk within fourteen days ".repeat(6)}end.`;
    const { summary } = wikiText(long);
    expect([...summary].length).toBeLessThanOrEqual(WIKI_SUMMARY_MAX);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary).not.toMatch(/\s…$/);
  });

  it("cuts text with no spaces at a character", () => {
    const { summary } = wikiText("退款".repeat(200));
    expect([...summary].length).toBe(WIKI_SUMMARY_MAX);
    expect(summary.endsWith("…")).toBe(true);
  });
});
