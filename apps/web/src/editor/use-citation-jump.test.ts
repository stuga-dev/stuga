// @vitest-environment jsdom
// Matching a Markdown excerpt against rendered DOM; landing nowhere beats landing on the wrong passage.
import { describe, it, expect, afterEach } from "vitest";
import { findTarget, jumpTo } from "./use-citation-jump";
import { citationHref } from "../ai/citations";

/** A stand-in for the editor's rendered body. */
function render(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

const DOC = render(`
  <h1>Upkeep</h1>
  <p>An introduction that mentions repairs in passing.</p>
  <h2>Week 2 — Repairs</h2>
  <p>Turn the listed repairs into <strong>dated</strong> jobs.</p>
  <h2>Week 2 — Repairs in Review</h2>
  <p>A later section whose heading merely starts the same way.</p>
  <h2>Costs</h2>
  <table><tbody><tr><td>Hosting</td><td>1200</td></tr></tbody></table>
`);

describe("findTarget", () => {
  it("lands on the section heading, so the reader can see which section they are in", () => {
    const el = findTarget(DOC, "Turn the listed repairs into dated jobs", "Upkeep > Week 2 — Repairs");
    expect(el?.tagName).toBe("H2");
    expect(el?.textContent).toBe("Week 2 — Repairs");
  });

  it("climbs to the section heading when only the snippet matches", () => {
    const el = findTarget(DOC, "into dated jobs", "");
    expect(el?.tagName).toBe("H2");
    expect(el?.textContent).toBe("Week 2 — Repairs");
  });

  it("falls back to the section heading when the snippet cannot match", () => {
    const el = findTarget(DOC, "text that appears nowhere in this document", "Upkeep > Costs");
    expect(el?.tagName).toBe("H2");
    expect(el?.textContent).toBe("Costs");
  });

  it("uses the block itself when the passage has no heading above it", () => {
    const NO_HEADING = render(`<p>A preamble before any heading at all.</p><h2>Later</h2>`);
    const el = findTarget(NO_HEADING, "preamble before any heading", "");
    expect(el?.tagName).toBe("P");
  });

  describe("repeated section names", () => {
    const REPEATED = render(`
      <h1>Spec</h1>
      <h2>Feature A</h2>
      <h3>Acceptance criteria</h3>
      <p>Alpha rules.</p>
      <h2>Feature B</h2>
      <h3>Acceptance criteria</h3>
      <p>Beta rules.</p>
    `);

    it("uses the ancestors to pick the right one", () => {
      const b = findTarget(REPEATED, "", "Spec > Feature B > Acceptance criteria");
      expect(b?.nextElementSibling?.textContent).toBe("Beta rules.");

      const a = findTarget(REPEATED, "", "Spec > Feature A > Acceptance criteria");
      expect(a?.nextElementSibling?.textContent).toBe("Alpha rules.");
    });

    it("still returns something when no ancestor matches", () => {
      const el = findTarget(REPEATED, "", "Spec > Feature Z > Acceptance criteria");
      expect(el?.textContent).toBe("Acceptance criteria");
    });
  });

  it("requires the heading to match exactly, not by prefix", () => {
    const el = findTarget(DOC, "", "Upkeep > Week 2 — Repairs");
    expect(el?.textContent).toBe("Week 2 — Repairs");
  });

  it("shows the section for a passage that renders only as a table cell", () => {
    const el = findTarget(DOC, "Hosting", "");
    expect(el?.textContent).toBe("Costs");
  });

  it("returns nothing rather than guessing", () => {
    expect(findTarget(DOC, "", "")).toBeNull();
    expect(findTarget(DOC, "nowhere at all", "No Such Section")).toBeNull();
  });

  it("round-trips a real citation through the link and back to the passage", () => {
    const href = citationHref({
      doc_id: "d1",
      heading_path: "Upkeep > Week 2 — Repairs",
      content: "## Week 2 — Repairs\n\nTurn the listed repairs into **dated** jobs.",
    });
    const params = new URL(href, "https://x.test").searchParams;
    const el = findTarget(DOC, params.get("q") ?? "", params.get("sec") ?? "");
    expect(el?.tagName).toBe("H2");
    expect(el?.textContent).toBe("Week 2 — Repairs");
    expect(el?.nextElementSibling?.textContent).toContain("Turn the listed repairs");
  });
});

describe("jumpTo", () => {
  // The fallback case needs no leftover scroller in the document.
  afterEach(() => {
    document.body.innerHTML = "";
  });

  /** A scroller at y=100 with a 40px sticky toolbar, and a target 500px down. */
  function scene({ targetTop }: { targetTop: number }) {
    const scroller = document.createElement("div");
    scroller.className = "doc-main";
    const toolbar = document.createElement("div");
    toolbar.className = "editor-toolbar-bar";
    const target = document.createElement("p");
    scroller.append(toolbar, target);
    document.body.append(scroller);

    scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    toolbar.getBoundingClientRect = () => ({ height: 40 }) as DOMRect;
    target.getBoundingClientRect = () => ({ top: targetTop }) as DOMRect;
    scroller.scrollTop = 0;
    return { scroller, target };
  }

  it("puts the passage at the top, below the sticky toolbar", () => {
    const { scroller, target } = scene({ targetTop: 600 });
    jumpTo(target);
    // 600 - 100 (scroller top) - 40 (toolbar) - 12 (gap) = 448
    expect(scroller.scrollTop).toBe(448);
  });

  it("scrolls backwards when the passage is above the viewport", () => {
    const { scroller, target } = scene({ targetTop: -200 });
    scroller.scrollTop = 900;
    jumpTo(target);
    expect(scroller.scrollTop).toBe(900 + (-200 - 100 - 40 - 12));
  });

  it("sets scrollTop outright instead of animating through scrollIntoView", () => {
    const { target } = scene({ targetTop: 600 });
    let called = false;
    target.scrollIntoView = () => {
      called = true;
    };
    jumpTo(target);
    expect(called).toBe(false);
  });

  it("falls back to scrollIntoView when there is no scroller", () => {
    const orphan = document.createElement("p");
    document.body.append(orphan);
    let opts: ScrollIntoViewOptions | undefined;
    orphan.scrollIntoView = (o?: boolean | ScrollIntoViewOptions) => {
      opts = o as ScrollIntoViewOptions;
    };
    jumpTo(orphan);
    expect(opts).toEqual({ behavior: "auto", block: "start" });
  });
});
