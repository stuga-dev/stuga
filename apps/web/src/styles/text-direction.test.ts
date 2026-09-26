// @vitest-environment jsdom
/**
 * Text people write takes its own direction: in an otherwise left-to-right page,
 * a block of Arabic reads right to left. jsdom applies the stylesheets to the
 * markup each surface renders.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { blockDiffMarkdown } from "@stuga/crdt-ops";
import { CitationPopover } from "../ai/CitationPopover";
import { renderAssistantHtml } from "../ai/render-markdown";
import type { DocSummary } from "../api";
import { DocTable, docRow, type LibraryRow } from "../library/DocTable";
import { BlockDiffView } from "../review/BlockDiffView";

vi.mock("../ui/narrow", () => ({ useIsNarrow: () => false }));
vi.mock("../state/identity", async (orig) => ({
  ...(await orig<typeof import("../state/identity")>()),
  useUserNames: () => undefined,
}));
vi.mock("../database/model/row-ref", async (orig) => ({
  ...(await orig<typeof import("../database/model/row-ref")>()),
  usePageParents: () => undefined,
}));
vi.mock("../lib/use-element-width", () => ({ useElementWidth: () => ({ ref: () => {}, width: 900 }) }));

// vitest stubs CSS imports, and cwd is the package root.
const DIR = resolve(process.cwd(), "src/styles");

beforeAll(() => {
  for (const sheet of ["base.css", "editor.css", "database.css", "library.css", "ask.css", "review.css"]) {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(DIR, sheet), "utf8");
    document.head.appendChild(style);
  }
});

/** `element` rendered into a fresh root in the page; the returned function unmounts it. */
async function mount(element: React.ReactElement): Promise<() => void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(element));
  return () => act(() => root.unmount());
}

/** The computed `unicode-bidi` of every element in `html` that `selector` matches. */
function bidiOf(html: string, selector: string): string[] {
  document.body.innerHTML = html;
  const found = [...document.querySelectorAll(selector)];
  expect(found.length).toBeGreaterThan(0);
  return found.map((el) => getComputedStyle(el).unicodeBidi);
}

/** The computed `unicode-bidi` of the element that directly holds `text`: the box its paragraph belongs to. */
function holderBidi(text: string): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent === text) return getComputedStyle(node.parentElement!).unicodeBidi;
  }
  throw new Error(`no text "${text}"`);
}

const EDITOR = `
  <div class="stuga-editor">
    <h2>عنوان</h2>
    <p>فقرة</p>
    <ul dir="auto"><li><p>بند</p></li></ul>
    <blockquote dir="auto"><p>اقتباس</p></blockquote>
    <table><tbody><tr><th><p>رأس</p></th><td><p>خلية</p></td></tr></tbody></table>
    <div data-footnote-def data-n="1">مصدر</div>
    <p>استخدم <code>x = 1;</code> هنا</p>
    <pre><code>const a = 1;</code></pre>
    <div class="mermaid-preview"><svg><foreignObject><div><p>label</p></div></foreignObject></svg></div>
  </div>`;

describe("text direction", () => {
  it("gives each editor block the direction of its own text", () => {
    const blocks = ".stuga-editor > h2, .stuga-editor > p, li, blockquote, th, td, [data-footnote-def], li > p, blockquote > p, td > p";
    expect(new Set(bidiOf(EDITOR, blocks))).toEqual(new Set(["plaintext"]));
  });

  it("keeps code left to right and leaves diagram labels as Mermaid measured them", () => {
    document.body.innerHTML = EDITOR;
    const pre = document.querySelector("pre")!;
    expect(getComputedStyle(pre).unicodeBidi).not.toBe("plaintext");
    expect(getComputedStyle(pre).direction).toBe("ltr");
    // Isolated, so a trailing `;` stays after the code in an Arabic line instead of moving before it.
    const code = getComputedStyle(document.querySelector("p > code")!);
    expect([code.unicodeBidi, code.direction]).toEqual(["isolate", "ltr"]);
    expect(getComputedStyle(document.querySelector("svg p")!).unicodeBidi).toBe("normal");
  });

  it("gives comments, the passages they quote and the comment box their own direction", () => {
    const html = `
      <li class="comment-item"><button class="comment-quote">نص مقتبس</button><p class="comment-text">راجع المادة 9.</p></li>
      <div class="comment-composer"><div class="comment-composer__quote">“نص مقتبس”</div></div>
      <div class="mention-textarea mention-textarea--below"><div class="astryx-text-area"><textarea>رد</textarea></div></div>`;
    const parts = ".comment-quote, .comment-text, .comment-composer__quote, textarea";
    expect(new Set(bidiOf(html, parts))).toEqual(new Set(["plaintext"]));
  });

  it("marks the outline's section and a comment's quote on the side their text starts, not on the left", () => {
    // Each row and quote carries dir="auto" (Outline.test.tsx, CommentsPanel.test.tsx); the marks follow it.
    document.body.innerHTML = `
      <div class="outline-row outline-row--active" dir="auto">المقدمة</div>
      <li class="comment-item"><button class="comment-quote" dir="auto">نص مقتبس</button></li>`;
    const row = getComputedStyle(document.querySelector(".outline-row--active")!);
    expect(row.getPropertyValue("border-inline-start-color")).toBe("var(--selection-mark)");
    expect(row.getPropertyValue("border-start-end-radius")).toBe("var(--radius-element)");
    expect(row.borderLeftWidth).toBe("0px");
    expect([row.borderTopRightRadius, row.borderBottomRightRadius]).toEqual(["0", "0"]);
    const quote = getComputedStyle(document.querySelector(".comment-quote")!);
    expect(quote.borderLeftWidth).toBe("0px");
    expect(quote.alignSelf).toBe("self-start");
  });

  it("gives the passage Edit with AI quotes and the changes Review each lists their own direction", () => {
    const html = `
      <div class="ai-edit-composer"><div class="ai-edit-composer__quote">“نص مقتبس”</div></div>
      <ul class="agent-run-changes"><li class="agent-run-change"><button class="agent-run-change__body">
        <span class="agent-run-change__marker">+</span><span class="agent-run-change__text">يطبق GDPR على الشركات</span>
      </button></li></ul>
      <div class="stuga-editor"><div class="ai-preview-ghost ai-preview-ghost--words"><span class="ai-preview-hunk">يطبق <ins>القانون</ins></span></div></div>`;
    const parts = ".ai-edit-composer__quote, .agent-run-change__text, .ai-preview-ghost--words .ai-preview-hunk";
    expect(new Set(bidiOf(html, parts))).toEqual(new Set(["plaintext"]));
  });

  it("puts a quote's or an excerpt's bar on the side its text starts, not on the left", async () => {
    // Each takes its text's direction (dir="auto"); the bar and its inset follow it.
    document.body.innerHTML = `
      <div class="comment-composer__quote" dir="auto">“نص”</div>
      <div class="ai-edit-composer__quote" dir="auto">“نص”</div>
      <div class="ai-turn-quote" dir="auto">نص</div>
      <blockquote class="sources-excerpt" dir="auto">نص</blockquote>
      <blockquote class="citation-popover__excerpt" dir="auto">نص</blockquote>`;
    for (const el of document.body.children) {
      const style = getComputedStyle(el);
      expect(style.borderLeftStyle, el.className).toBe("none");
      expect(style.paddingLeft, el.className).toMatch(/^0(px)?$/);
      expect(style.getPropertyValue("border-inline-start"), el.className).toMatch(/solid/);
      expect(style.getPropertyValue("padding-inline-start"), el.className).toMatch(/^[1-9][\d.]*px$/);
    }
    const unmount = await mount(
      createElement(CitationPopover, {
        citation: { n: 1, doc_id: "d_1", title: "قانون", heading_path: null, content: "نص المادة" } as never,
        anchor: { top: 0, left: 0, anchorTop: 0 },
        onClose: () => {},
      }),
    );
    expect(document.querySelector(".citation-popover__excerpt")!.getAttribute("dir")).toBe("auto");
    unmount();
  });

  it("gives the changes Review AI edits and version compare show their blocks' direction", async () => {
    const blocks = blockDiffMarkdown("فقرة\n", "فقرة\n\n- بند\n- item\n\n> اقتباس\n");
    const unmount = await mount(createElement(BlockDiffView, { blocks, changed: true, loading: false, unchangedText: "No changes" }));
    expect(document.querySelectorAll(".vcompare-block--ins").length).toBeGreaterThan(0);
    expect([...document.querySelectorAll(".vcompare-block ul, .vcompare-block blockquote")].map((el) => el.getAttribute("dir"))).toEqual([
      "auto",
      "auto",
    ]);
    const paragraphs = [...document.querySelectorAll(".vcompare-block p, .vcompare-block li")];
    expect(new Set(paragraphs.map((el) => getComputedStyle(el).unicodeBidi))).toEqual(new Set(["plaintext"]));
    unmount();
  });

  it("gives database cells, column names and row panel fields their own direction", () => {
    const html = `
      <div class="row-panel__head"><span class="astryx-text row-panel__title">9 الإبلاغ</span></div>
      <table class="db-grid"><tbody>
        <tr><th><button class="db-col-head__sort"><span class="db-col-head__label">الاسم</span></button></th></tr>
        <tr><td class="db-td"><button class="db-cell">قيمة</button></td>
            <td class="db-td"><span class="db-cell db-cell--proposed">مقترح</span></td>
            <td class="db-td db-td--editing"><input class="db-cell-input" value="قيمة"></td></tr>
      </tbody></table>
      <dl class="row-panel__fields"><div class="row-panel__field">
        <dt class="row-panel__label">الاسم</dt>
        <dd class="row-panel__value"><textarea class="row-panel__textarea">قيمة</textarea><input class="row-panel__input"></dd>
      </div></dl>`;
    const cells = ".db-col-head__label, .db-cell, .db-cell-input, .row-panel__title, .row-panel__label, .row-panel__textarea, .row-panel__input";
    expect(new Set(bidiOf(html, cells))).toEqual(new Set(["plaintext"]));
  });

  it("gives search hits' titles and snippets their own direction", () => {
    const html = `<span class="bidi-line">قانون العمل</span><span class="snippet">نص <mark>العمل</mark></span>`;
    expect(new Set(bidiOf(html, ".bidi-line, .snippet"))).toEqual(new Set(["plaintext"]));
  });

  it("gives library titles and names their own direction, so a cut one keeps its start", async () => {
    const doc: DocSummary = {
      doc_id: "d_1",
      title: "قانون العمل",
      owner: "user:u_liv",
      doc_type: "prose",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      trashed: false,
      trashed_at: null,
      parent_id: null,
      locked: false,
      search_hidden: false,
      agent_mode: "review",
      page_of: "d_db",
      page_row: "t_1.r_1",
    };
    const folder: LibraryRow = { ...docRow(doc), id: "f_1", kind: "folder", title: "القوانين", doc: undefined };
    const rows = [{ ...docRow(doc), location: "مستندات" }, { ...folder, location: "الأرشيف" }];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        createElement(DocTable, {
          rows,
          columns: ["name", "location"],
          selectedIds: new Set<string>(),
          onSelectionChange: () => {},
          onActivate: () => {},
          sort: { key: "updated_at", direction: "descending" },
          onSortChange: () => {},
          rowActions: () => [],
        }),
      ),
    );
    // A document's title sits in a Link and its Text, flex boxes that a rule on the cell does not reach.
    expect(document.querySelector('a[href="/doc/d_1"]')).not.toBeNull();
    const texts = ["قانون العمل", "القوانين", "Database", "مستندات", "الأرشيف"];
    expect(texts.map(holderBidi)).toEqual(texts.map(() => "plaintext"));
    act(() => root.unmount());
  });

  it("gives an Ask answer's blocks their own direction, lists and quotes their first text's", () => {
    const answer = renderAssistantHtml("## عنوان\n\nفقرة\n\n- بند\n- item\n\n> اقتباس\n\n```\nconst a = 1;\n```");
    const html = `<h2 class="ask-turn__question">سؤال</h2><div class="ask-turn__answer"><div class="ai-md">${answer}</div></div>`;
    expect(new Set(bidiOf(html, ".ask-turn__question, .ai-md h2, .ai-md p, .ai-md li"))).toEqual(new Set(["plaintext"]));
    expect([...document.querySelectorAll(".ai-md ul, .ai-md blockquote")].map((el) => el.getAttribute("dir"))).toEqual([
      "auto",
      "auto",
    ]);
    expect(getComputedStyle(document.querySelector(".ai-md pre")!).unicodeBidi).not.toBe("plaintext");
  });

  it("gives Ask's composers, saved questions, quoted selection and cited sections their own direction", () => {
    const html = `
      <div class="ai-input">
        <div class="ai-input-quote"><span class="ai-input-quote__label">Selected</span><span class="ai-input-quote__text">نص</span></div>
        <div class="ai-composer"><div class="astryx-text-area"><textarea>سؤال</textarea></div></div>
      </div>
      <div class="ask-composer"><div class="ask-composer__box"><div class="astryx-text-area"><textarea>سؤال</textarea></div></div></div>
      <div class="ask-rail__row"><div class="astryx-side-nav-item"><button><span class="rail-label">سؤال محفوظ</span></button></div></div>
      <a class="ask-source-card"><span class="ask-source-card__section">المادة (9)</span></a>
      <div class="citation-popover__source"><span class="citation-popover__source-name">قانون</span></div>`;
    const parts = ".ai-input-quote__text, textarea, .rail-label, .ask-source-card__section, .citation-popover__source-name";
    expect(new Set(bidiOf(html, parts))).toEqual(new Set(["plaintext"]));
    expect(getComputedStyle(document.querySelector(".ai-input-quote__label")!).unicodeBidi).not.toBe("plaintext");
  });

  it("keeps inline code in an Ask answer left to right", () => {
    document.body.innerHTML = `<div class="ai-md">${renderAssistantHtml("استخدم `x = 1;` هنا")}</div>`;
    const code = getComputedStyle(document.querySelector(".ai-md p > code")!);
    expect([code.unicodeBidi, code.direction]).toEqual(["isolate", "ltr"]);
  });
});
