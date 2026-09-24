import { describe, it, expect } from "vitest";
import {
  citationHref,
  citedSources,
  excerptSnippet,
  headingSegments,
  readableExcerpt,
  sectionLabel,
  stripMarkdown,
} from "./citations";

describe("headingSegments", () => {
  it("splits a path and drops the padding", () => {
    expect(headingSegments("Upkeep > Phase 2 > 2.2 Hand-off")).toEqual(["Upkeep", "Phase 2", "2.2 Hand-off"]);
  });

  it("is empty for nothing", () => {
    expect(headingSegments(null)).toEqual([]);
    expect(headingSegments(" > ")).toEqual([]);
  });
});

describe("excerptSnippet", () => {
  it("skips the excerpt's own heading line and returns prose", () => {
    const snip = excerptSnippet("## Week 2 — Repairs\n\n**Aim:** Turn the listed repairs into dated jobs.");
    expect(snip.startsWith("Aim: Turn the listed")).toBe(true);
    expect(snip).not.toContain("#");
    expect(snip).not.toContain("*");
  });

  it("stops on a word boundary so it cannot end mid-token", () => {
    const long = "word ".repeat(60);
    const snip = excerptSnippet(long);
    expect(snip.length).toBeLessThanOrEqual(80);
    expect(snip.endsWith("word")).toBe(true);
  });

  it("returns nothing when there is no usable prose", () => {
    expect(excerptSnippet("")).toBe("");
    expect(excerptSnippet(null)).toBe("");
    expect(excerptSnippet("## Only A Heading")).toBe("");
    expect(excerptSnippet("tiny")).toBe("");
  });
});

describe("stripMarkdown", () => {
  it("removes syntax the rendered DOM never contains", () => {
    expect(stripMarkdown("**bold** and `code` and _em_")).toBe("bold and code and em");
    expect(stripMarkdown("| Element | Detail |")).toBe("Element Detail");
    expect(stripMarkdown("> quoted")).toBe("quoted");
    expect(stripMarkdown("- item")).toBe("item");
  });

  it("keeps a link's visible label", () => {
    expect(stripMarkdown("see [the runbook](https://example.com/x)")).toBe("see the runbook");
  });
});

describe("citationHref", () => {
  it("carries both the passage snippet and the section fallback", () => {
    const href = citationHref({
      doc_id: "d1",
      heading_path: "Upkeep > Week 2 — Repairs",
      content: "## Week 2 — Repairs\n\nTurn the listed repairs into dated jobs.",
    });
    const url = new URL(href, "https://x.test");
    expect(url.pathname).toBe("/doc/d1");
    expect(url.searchParams.get("sec")).toBe("Upkeep > Week 2 — Repairs");
    expect(url.searchParams.get("q")).toContain("Turn the listed repairs");
  });

  it("degrades to a plain document link when there is nothing to anchor on", () => {
    expect(citationHref({ doc_id: "d1" })).toBe("/doc/d1");
    expect(citationHref({ doc_id: "d1", heading_path: "", content: "" })).toBe("/doc/d1");
  });

  it("sends only the section when the excerpt is a table", () => {
    const href = citationHref({ doc_id: "d1", heading_path: "Doc > Costs", content: "## Costs\n\n| A | B |" });
    const url = new URL(href, "https://x.test");
    expect(url.searchParams.get("sec")).toBe("Doc > Costs");
    expect(url.searchParams.get("q")).toBeNull();
  });

  it("url-encodes text that would otherwise break the query string", () => {
    const href = citationHref({ doc_id: "d1", heading_path: "Doc > A&B?", content: "" });
    expect(href).toContain("%26");
    expect(new URL(href, "https://x.test").searchParams.get("sec")).toBe("Doc > A&B?");
  });
});

describe("sectionLabel", () => {
  it("drops the leading document title so the section is what you read", () => {
    expect(sectionLabel("Cottage Upkeep & Repair — Handbook > Entry by Work Type", "Cottage Upkeep & Repair — Handbook")).toBe(
      "Entry by Work Type",
    );
  });

  it("joins deeper paths readably", () => {
    expect(sectionLabel("Doc > Phase 2 > 2.2 Hand-off", "Doc")).toBe("Phase 2 › 2.2 Hand-off");
  });

  it("keeps the path when the first segment is not the title", () => {
    expect(sectionLabel("Overview > Details", "Something Else")).toBe("Overview › Details");
  });

  it("keeps a single segment even when it equals the title", () => {
    expect(sectionLabel("Doc", "Doc")).toBe("Doc");
  });

  it("is empty when there is no path", () => {
    expect(sectionLabel(null, "Doc")).toBe("");
  });
});

describe("readableExcerpt", () => {
  it("renders Markdown as prose a person can read", () => {
    const raw = "## Entry by Work Type\n\nWork starts at the **earliest** applicable phase.\n\n| Work type | Route |";
    const out = readableExcerpt(raw);
    expect(out).not.toContain("#");
    expect(out).not.toContain("*");
    expect(out).not.toContain("|");
    expect(out.startsWith("Work starts at the earliest applicable phase.")).toBe(true);
  });

  it("drops the heading, which the card already shows as its section", () => {
    expect(readableExcerpt("## Costs\n\nHosting is billed monthly.")).toBe("Hosting is billed monthly.");
  });

  it("is empty for nothing", () => {
    expect(readableExcerpt(null)).toBe("");
    expect(readableExcerpt("## Heading only")).toBe("");
  });
});

describe("citedSources", () => {
  it("keeps one entry per document, in first-cited order", () => {
    const cite = (n: number, doc_id: string, title: string) => ({ n, doc_id, title, content: "" });
    expect(citedSources([cite(1, "b", "B"), cite(2, "a", "A"), cite(3, "b", "B again")])).toEqual([
      { doc_id: "b", title: "B" },
      { doc_id: "a", title: "A" },
    ]);
  });
});
