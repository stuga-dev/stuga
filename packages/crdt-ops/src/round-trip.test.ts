/**
 * The round-trip invariant over a broad corpus, for any reachable document:
 *
 *     markdownToDoc(docToMarkdown(doc))  ==  doc      (structurally)
 *     docToMarkdown(markdownToDoc(md))   ==  md       (fixed point)
 *
 * The review overlay diffs the live document against re-parsed markdown, so any
 * divergence is a phantom concurrent edit. Shapes that cannot round-trip are
 * pinned under "documented losses" with the reason each is unavoidable.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type { Node as PMNode } from "prosemirror-model";
import {
  getStugaSchema,
  markdownToDoc,
  docToMarkdown,
  applyMarkdownToYXmlFragment,
  yXmlFragmentToMarkdown,
} from "./index.js";

const schema = getStugaSchema();

/** doc → markdown → doc must be structurally identical, and the markdown a fixed point. */
function assertDocRoundTrip(doc: PMNode, label: string): string {
  const md1 = docToMarkdown(doc);
  const doc1 = markdownToDoc(md1, schema);
  expect(doc1.toJSON(), `${label}: parse(serialize(doc)) !== doc\n--- markdown ---\n${md1}\n---`).toEqual(doc.toJSON());
  expect(docToMarkdown(doc1), `${label}: serialization is not a fixed point`).toBe(md1);
  return md1;
}

/** Same, entered from markdown (the AI-authored side). */
function assertMarkdownRoundTrip(md: string, label: string): PMNode {
  const doc = markdownToDoc(md, schema);
  assertDocRoundTrip(doc, label);
  return doc;
}

// ---------------------------------------------------------------------------
// Corpus entered from markdown: each case is a shape the round trip must hold.
// ---------------------------------------------------------------------------
const MARKDOWN_CORPUS: [name: string, md: string][] = [
  ["heading levels", "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six"],
  ["heading ending in a hash run", "## Bug in C\\#\n\nbody"],
  ["paragraph", "Just a sentence."],
  ["marks mid-sentence", "A **bold** and *italic* and `code` and ~~strike~~ run."],
  ["marks hugging punctuation", "**Bold**, *italic*; `code`. ~~gone~~!"],
  ["nested marks", "***both*** and **bold with *inner italic* tail**."],
  ["link without title", "See [the docs](https://example.com/a_b) for more."],
  ["link with title", 'See [the docs](https://example.com "The Docs") for more.'],
  ["link with parens in the url", "See [ref](https://example.com/a\\(b\\)c) here."],
  ["link with a space in the url", "See [file](<./report draft.md>) here."],
  ["relative link", "See [doc](/doc/abc123) here."],
  // A code span evicts the marks markdown cannot spell inside backticks; the
  // enclosing mark must resume after the span.
  ["bold ending in a space before a code span", "> **Task&#32;**`Spent` = the evidence"],
  ["bold spanning a code span", "The **plan in&#32;**`x.com`**&#32;is the record** — yes"],
  // `link` is NOT evicted — markdown spells it outside the backticks — so a code
  // span that is a link's text keeps its href, and one that merely sits inside a
  // longer label stays part of the same single link.
  ["code span as the whole link text", "See [`x.com`](https://x.com/) here"],
  ["code span inside a longer link label", "A [link with `code` inside](https://x.com/) here"],
  ["code span link with a title", 'Run [`build`](https://x.com/ "How") first'],
  // A link split around a bare code span (three adjacent inlines) is a fixed point.
  ["link split around a code span", "A [link with ](https://x.com/)`code`[ inside](https://x.com/) here"],
  ["bold around a code-span link", "The **plan in&#32;**[`x.com`](https://x.com/)**&#32;is the record** — yes"],
  ["italic hugging a code span on both sides", "*a&#32;*`b`*&#32;c* tail"],
  ["strike ending in a space before a code span", "~~gone&#32;~~`kept` after"],
  ["code span between two bold runs", "**one&#32;**`mid`**&#32;two**"],
  // The same repair where the neighbour is plain PROSE: its boundary letter is
  // respelt as a character reference so the delimiter run still closes. Entered
  // from markdown here so the CRDT path below covers it too.
  ["bold keeping its trailing space before prose", "**bold&#32;**&#116;ail here"],
  ["bold keeping its leading space after prose", "hea&#100;**&#32;bold** here"],
  ["hard break", "first line\\\nsecond line"],
  ["hard break followed by list-looking text", "first line\\\n\\- not a bullet"],
  ["hard break followed by ordered-list-looking text", "first line\\\n1\\. not a list"],
  ["hard break followed by a setext rule", "first line\\\n\\=== not a heading"],
  ["blockquote", "> quoted text\n>\n> second paragraph"],
  ["nested blockquote", "> outer\n>\n> > inner"],
  ["adjacent blockquotes", "> first quote\n\n> second quote"],
  ["bullet list", "* alpha\n* beta"],
  ["adjacent bullet lists", "* alpha\n* beta\n\n- gamma\n- delta"],
  ["ordered list", "1. alpha\n2. beta"],
  ["ordered list with a start", "5. five\n6. six"],
  ["ordered list starting at zero", "0. zero\n1. one"],
  ["adjacent ordered lists", "1. alpha\n2. beta\n\n1) gamma\n2) delta"],
  ["nested list", "* outer\n\n  * inner one\n  * inner two\n* sibling"],
  ["list holding a blockquote", "* item\n\n  > quoted"],
  ["code fence with a language", "```ts\nconst x: number = 1;\n```"],
  ["code fence without a language", "```\nplain text\n```"],
  ["code fence containing backticks", "````\n```\nnested\n```\n````"],
  ["code fence containing markdown", "```md\n# not a heading\n\n* not a list\n```"],
  ["horizontal rule", "above\n\n---\n\nbelow"],
  ["em dash and typographic quotes", "He said \u201cthe budget \u2014 all of it \u2014 is gone\u201d, then \u2018left\u2019."],
  ["ellipsis and non-breaking space", "Wait\u2026 for\u00a0it."],
  ["escaped markdown characters", "Literal \\*stars\\*, \\_unders\\_, \\`ticks\\`, \\[brackets\\] and a backslash \\\\."],
  ["text that looks like an entity", "Ampersand \\&amp; and \\&#32; stay literal."],
  ["text that looks like an autolink", "The string \\<https://example.com> is not a link."],
  ["text that looks like an email autolink", "Write \\<a@b.com> in angle brackets."],
  ["pipes in a paragraph", "a | b | c is not a table."],
  ["mention", "Ask [@ada](mention:u_ada) about it."],
  ["mention with escaped label characters", "Ping [@first\\_last \\[x\\]](mention:auth0%7C123) now."],
  ["mention inside emphasis", "**Owner: [@ada](mention:u_ada)**"],
  ["link to a mention target with more than @text stays a link", "[see **@ada**](mention:u_ada)"],
  ["link whose text is not an @ stays a link", "[ada](mention:u_ada)"],
  ["image", "![alt text](./img.png)"],
  ["image with a title", '![alt text](./img.png "The Title")'],
  ["image with brackets in the alt", "![a \\[b\\] c](./img.png)"],
  ["image with a space in the src", "![shot](<./report draft.png>)"],
  ["footnote: referenced", "Cited here [^1].\n\n[^1]: [Source](/doc/x) \"excerpt\""],
  ["footnote: two references, one definition", "One [^1] and again [^1].\n\n[^1]: shared source"],
  ["footnote: orphaned definition", "No markers in this body.\n\n[^1]: orphan definition"],
  ["footnote: orphaned reference", "A marker [^9] with nothing behind it."],
  ["footnote: definition above its reference", "[^1]: defined first\n\nProse citing it [^1]."],
  ["footnote: definition between paragraphs", "Alpha [^1].\n\n[^1]: middle\n\nBeta."],
  ["footnote: marks inside the definition", "Cited [^1].\n\n[^1]: **bold** and `code` and [link](/x)"],
  ["table: plain", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  ["table: all alignments", "| l | c | r | n |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |"],
  ["table: marks in cells", "| Term | Meaning |\n| --- | --- |\n| **Epic** | `ADR` and [docs](/x) |"],
  ["table: strike and italics in cells", "| a | b |\n| --- | --- |\n| ~~old~~ | *new* |"],
  ["table: escaped pipe in a cell", "| a | b |\n| --- | --- |\n| x \\| y | z |"],
  ["table: backslash in a cell", "| a | b |\n| --- | --- |\n| C:\\\\path | \\*not italic\\* |"],
  ["table: footnote reference in a cell", "| a | b |\n| --- | --- |\n| Build [^2] | x |\n\n[^2]: [Src](/doc/g) \"e\""],
  ["table: aligned with marks", "| a | b |\n| --: | :-: |\n| **1** | *2* |\n| 3 | 4 |"],
  ["table: empty cells", "| a | b |\n| --- | --- |\n|  | 2 |"],
  ["table inside a list item", "* item\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |"],
  [
    "kitchen sink",
    [
      "# Title",
      "",
      "Intro with **bold**, a [link](https://example.com \"T\"), and a citation [^1].",
      "",
      "* alpha",
      "* beta",
      "",
      "- gamma",
      "",
      "> a quote with `code`",
      "",
      "| Col | Val |",
      "| :-- | --: |",
      "| **x** | 1 |",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "---",
      "",
      "[^1]: [Source \u2014 Section](/doc/abc) \"frozen excerpt\"",
    ].join("\n"),
  ],
];

describe("round-trip invariant: markdown -> doc -> markdown", () => {
  for (const [name, md] of MARKDOWN_CORPUS) {
    it(name, () => {
      assertMarkdownRoundTrip(md, name);
    });
  }

  it("holds on the live CRDT path too (Y.XmlFragment, not just markdownToDoc)", () => {
    // markdownToDoc alone would hide a divergence that only the y-prosemirror
    // binding surfaces: the preview diffs against a doc rebuilt FROM Yjs, whose
    // attrs/defaults come back through the XmlFragment encoding.
    for (const [name, md] of MARKDOWN_CORPUS) {
      const frag = new Y.Doc().getXmlFragment("default");
      applyMarkdownToYXmlFragment(frag, md);
      const once = yXmlFragmentToMarkdown(frag);
      const frag2 = new Y.Doc().getXmlFragment("default");
      applyMarkdownToYXmlFragment(frag2, once);
      expect(yXmlFragmentToMarkdown(frag2), `${name}: CRDT projection is not a fixed point`).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// Corpus entered from the DOCUMENT side: shapes the editor can produce that no
// author would type as markdown.
// ---------------------------------------------------------------------------
const t = (text: string, ...marks: string[]): PMNode =>
  schema.text(
    text,
    marks.map((m) => schema.marks[m]!.create(m === "link" ? { href: "https://example.com", title: null } : null)),
  );
const p = (...inline: PMNode[]): PMNode => schema.nodes.paragraph!.create(null, inline);
const doc = (...blocks: PMNode[]): PMNode => schema.topNodeType.create(null, blocks);

describe("round-trip invariant: doc -> markdown -> doc", () => {
  const cases: [name: string, node: PMNode][] = [
    ["bold with a trailing space OUTSIDE the mark", doc(p(t("Grain", "bold"), t(": rice")))],
    ["leading whitespace in a paragraph", doc(p(t("   indented prose")))],
    ["trailing whitespace in a paragraph", doc(p(t("trailing space here   ")))],
    ["four leading spaces (would be an indented code block)", doc(p(t("    four spaces")))],
    [
      "hard break whose next line starts a bullet",
      doc(p(t("first"), schema.nodes.hardBreak!.create(), t("- second"))),
    ],
    [
      "hard break whose next line starts an ordered item",
      doc(p(t("first"), schema.nodes.hardBreak!.create(), t("1. second"))),
    ],
    [
      "hard break whose next line starts a blockquote",
      doc(p(t("first"), schema.nodes.hardBreak!.create(), t("> second"))),
    ],
    [
      "hard break whose next line starts a heading",
      doc(p(t("first"), schema.nodes.hardBreak!.create(), t("# second"))),
    ],
    [
      "hard break inside a list item",
      doc(
        schema.nodes.bulletList!.create(null, [
          schema.nodes.listItem!.create(null, [p(t("a"), schema.nodes.hardBreak!.create(), t("- b"))]),
        ]),
      ),
    ],
    ["link mark with no title attr", doc(p(t("see ", "link"), t("here")))],
    ["footnote reference at the very start of a paragraph", doc(p(schema.nodes.footnoteReference!.create({ n: 3 }), t(" leads")))],
    ["footnote definition holding only a link", doc(schema.nodes.footnoteDefinition!.create({ n: 1 }, [t("src", "link")]))],
    ["heading ending in a hash run", doc(schema.nodes.heading!.create({ level: 2 }, [t("C #")]))],
    ["text with an em dash and curly quotes", doc(p(t("\u201cthe budget \u2014 all\u201d \u2018x\u2019")))],
    ["ordered list starting at 0", doc(schema.nodes.orderedList!.create({ start: 0 }, [
      schema.nodes.listItem!.create(null, [p(t("zero"))]),
    ]))],
  ];
  for (const [name, node] of cases) {
    it(name, () => {
      assertDocRoundTrip(node, name);
    });
  }
});

// ---------------------------------------------------------------------------
// Property test: a seeded generator over the same feature space, so a divergence
// nobody thought to enumerate still fails the build. Deterministic (fixed seed)
// — a failure reproduces exactly.
// ---------------------------------------------------------------------------

/** Mulberry32: tiny deterministic PRNG, so a failing case is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// A deliberately hostile alphabet: every markdown metacharacter the serializer
// has to neutralize, plus the typographic characters the AI writes.
const WORDS = [
  "alpha",
  "beta",
  "x",
  "a*b",
  "under_score",
  "snake_case_word",
  "back`tick",
  "brack[et]",
  "paren(s)",
  "pipe|bar",
  "amp&amp;",
  "lt<https://x.com>",
  "hash#tag",
  "1.",
  "1)",
  "===",
  "---",
  "> quote",
  "* star",
  "+ plus",
  "!bang",
  "back\\slash",
  "tilde~~x",
  "\u2014dash",
  "\u201cquoted\u201d",
  "\u2018single\u2019",
  "^[inline note]",
  "[^7]",
  "C:\\path\\to",
];
function makeGen(seed: number) {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const chance = (p: number): boolean => rand() < p;
  const count = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

  /** A text run, sometimes marked, sometimes padded with the edge whitespace that
   *  markdown fights hardest over. */
  function textRun(): PMNode {
    const words: string[] = [];
    for (let i = count(1, 3); i > 0; i--) words.push(pick(WORDS));
    let s = words.join(" ");
    if (chance(0.2)) s = " ".repeat(count(1, 5)) + s;
    if (chance(0.2)) s = s + " ".repeat(count(1, 3));
    if (!chance(0.55)) return schema.text(s);
    // `code` is verbatim, so no emphasis can live inside the span, and its own
    // backticks would reopen it. A LINK can wrap it, though — markdown spells the
    // destination outside the backticks — so that pair is generated too.
    if (chance(0.2)) {
      const codeMarks = [schema.marks.code!.create()];
      if (chance(0.3)) {
        codeMarks.push(
          schema.marks.link!.create({ href: "/doc/" + count(1, 99), title: chance(0.3) ? "T" : null }),
        );
      }
      return schema.text(s.replace(/`/g, "'"), codeMarks);
    }
    const marks = [] as ReturnType<(typeof schema.marks)[string]["create"]>[];
    // `underline` is deliberately absent: it has no markdown syntax at all, so it
    // is a documented loss pinned by its own test rather than a property.
    for (const name of ["bold", "italic", "strike", "link"]) {
      if (!chance(0.3)) continue;
      marks.push(
        schema.marks[name]!.create(
          name === "link" ? { href: "/doc/" + count(1, 99), title: chance(0.3) ? "T" : null } : null,
        ),
      );
    }
    return schema.text(s, marks);
  }

  /**
   * Whitespace at a flanked mark's own edge survives everywhere EXCEPT against a
   * neighbouring flanked mark's delimiter, so that is the only place the
   * generator trims it.
   *
   * `**Task&#32;**` closes as long as the character after it is punctuation or
   * whitespace, and the serializer arranges that: a line edge and a code span
   * supply it directly, and ordinary text is respelt as a character reference
   * (`**bold&#32;**&#116;ail`). What it cannot arrange is a neighbouring `*`/`~`
   * run, which FUSES with this one into a single longer run — `*a&#32;***b**`
   * has no correct reading — so those edges are still expelled (the documented
   * loss below) and the generator does not emit them.
   *
   * The rule is deliberately CONSERVATIVE: it trims against any non-shared
   * bold/italic/strike neighbour, including combinations that would in fact
   * survive (`**a&#32;**~~b~~`). A trimmed case merely goes uncovered, whereas a
   * wrongly-kept one would fail the property for a reason already decided.
   */
  function trimMidLineMarkEdges(nodes: PMNode[]): PMNode[] {
    const flanked = new Set(["bold", "italic", "strike", "code"]);
    const fusable = new Set(["bold", "italic", "strike"]);
    /** Does the sibling write a delimiter that could fuse with `n`'s own? */
    const fuses = (sib: PMNode | undefined, n: PMNode): boolean =>
      !!sib?.isText && sib.marks.some((m) => fusable.has(m.type.name) && !m.isInSet(n.marks));
    const out: PMNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (!n.isText || !n.marks.some((m) => flanked.has(m.type.name))) {
        out.push(n);
        continue;
      }
      const keepStart = i === 0 || nodes[i - 1]!.type.name === "hardBreak" || !fuses(nodes[i - 1], n);
      const keepEnd = i === nodes.length - 1 || nodes[i + 1]!.type.name === "hardBreak" || !fuses(nodes[i + 1], n);
      let text = n.text ?? "";
      if (!keepStart) text = text.replace(/^\s+/, "");
      if (!keepEnd) text = text.replace(/\s+$/, "");
      if (text) out.push(schema.text(text, n.marks));
    }
    return out;
  }

  /** Inline content. `breaks` gates hardBreak (illegal-ish in one-line blocks). */
  function inline(breaks: boolean): PMNode[] {
    const out: PMNode[] = [];
    for (let i = count(1, 4); i > 0; i--) {
      if (breaks && out.length > 0 && chance(0.15)) {
        out.push(schema.nodes.hardBreak!.create());
        out.push(textRun());
        continue;
      }
      if (chance(0.1)) {
        out.push(schema.nodes.footnoteReference!.create({ n: count(1, 9) }));
        continue;
      }
      if (out.length > 0) out.push(schema.text(" "));
      out.push(textRun());
    }
    return trimMidLineMarkEdges(out);
  }

  function image(): PMNode {
    return schema.nodes.image!.create({
      src: pick(["./a.png", "./report draft.png", "https://x.com/a(b).png", "/img/1.svg"]),
      alt: chance(0.5) ? pick(["a [b] c", "shot", "a*b", ""]) || null : null,
      title: chance(0.3) ? "T" : null,
    });
  }

  function listItems(depth: number): PMNode[] {
    const items: PMNode[] = [];
    for (let i = count(1, 3); i > 0; i--) {
      // A list item whose first block is an image: what the image hoist leaves for `* ![x](x.png) tail`.
      if (chance(0.15)) {
        items.push(
          schema.nodes.listItem!.create(null, [
            schema.nodes.paragraph!.create(),
            image(),
            schema.nodes.paragraph!.create(null, inline(false)),
          ]),
        );
        continue;
      }
      const kids: PMNode[] = [schema.nodes.paragraph!.create(null, inline(true))];
      if (depth < 2 && chance(0.3)) kids.push(block(depth + 1, /* inList */ true));
      items.push(schema.nodes.listItem!.create(null, kids));
    }
    return items;
  }

  function cell(header: boolean): PMNode {
    const type = header ? schema.nodes.tableHeader! : schema.nodes.tableCell!;
    // GFM carries alignment per COLUMN; the caller fixes it per column so the
    // cells of one column never disagree (see the documented loss below).
    return type.create(null, [schema.nodes.paragraph!.create(null, inline(false))]);
  }

  function table(): PMNode {
    const cols = count(1, 3);
    const aligns = Array.from({ length: cols }, () => pick([null, "left", "center", "right"] as const));
    const row = (header: boolean): PMNode =>
      schema.nodes.tableRow!.create(
        null,
        Array.from({ length: cols }, (_, i) => {
          const c = cell(header);
          return c.type.create({ ...c.attrs, align: aligns[i] ?? null }, c.content);
        }),
      );
    const rows: PMNode[] = [row(true)];
    for (let i = count(1, 3); i > 0; i--) rows.push(row(false));
    return schema.nodes.table!.create(null, rows);
  }

  function block(depth: number, inList = false): PMNode {
    const kinds = inList
      ? (["bulletList", "orderedList", "blockquote", "codeBlock", "paragraph"] as const)
      : (["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule", "table", "footnoteDefinition", "image"] as const);
    switch (pick(kinds)) {
      case "heading":
        return schema.nodes.heading!.create({ level: count(1, 6) }, inline(false));
      case "bulletList":
        return schema.nodes.bulletList!.create(null, listItems(depth));
      case "orderedList":
        return schema.nodes.orderedList!.create({ start: count(0, 12) }, listItems(depth));
      case "blockquote":
        return schema.nodes.blockquote!.create(null, [
          schema.nodes.paragraph!.create(null, inline(true)),
          ...(depth < 2 && chance(0.3) ? [block(depth + 1, true)] : []),
        ]);
      case "codeBlock":
        return schema.nodes.codeBlock!.create({ language: chance(0.5) ? "ts" : null }, [
          schema.text("const x = 1;\n# not a heading\n" + pick(WORDS)),
        ]);
      case "horizontalRule":
        return schema.nodes.horizontalRule!.create();
      case "image":
        return image();
      case "table":
        return table();
      case "footnoteDefinition":
        return schema.nodes.footnoteDefinition!.create({ n: count(1, 9) }, inline(false));
      default:
        return schema.nodes.paragraph!.create(null, inline(true));
    }
  }

  return () => schema.topNodeType.create(null, Array.from({ length: count(1, 6) }, () => block(0)));
}

/**
 * Seeds run per test invocation. Kept small enough to stay a fast unit test;
 * raise it (`ROUND_TRIP_SEEDS=40000 pnpm test`) to fuzz harder after touching
 * the markdown modules — the failure message prints the seed and the offending markdown,
 * and the generator is deterministic, so any hit reproduces exactly.
 */
const SEEDS = Number(process.env.ROUND_TRIP_SEEDS ?? 2000);

describe("round-trip invariant: seeded property test", () => {
  // The budget scales with the seed count so a timeout only means a hung generator.
  it(
    `holds for ${SEEDS} generated documents`,
    () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const generated = makeGen(seed)();
        assertDocRoundTrip(generated, `seed ${seed}`);
      }
    },
    Math.max(30_000, SEEDS * 15),
  );
});

// ---------------------------------------------------------------------------
// MARKS ACROSS A CODE SPAN. `code` evicts the marks markdown cannot spell inside
// backticks and keeps `link`, which markdown spells outside them: the parser must
// restore evicted marks after the span, the serializer must keep edge whitespace
// held by a character reference, and a link whose text is a code span keeps its href.
// ---------------------------------------------------------------------------
describe("marks around a code span", () => {
  /** The marks on each inline child, in document order. */
  const marksOf = (md: string): string[][] => {
    const out: string[][] = [];
    markdownToDoc(md, schema)
      .firstChild!.content.forEach((n) => out.push(n.marks.map((m) => m.type.name)));
    return out;
  };

  it("keeps the enclosing mark alive AFTER the span", () => {
    expect(marksOf("The **plan in `x.com` is the record** — yes")).toEqual([[], ["bold"], ["code"], ["bold"], []]);
  });

  it("carries the link THROUGH an inner code span, not just around it", () => {
    // The span itself is part of the link's text in the source, so it must be
    // part of the link in the document too — `code` does not exclude `link`.
    expect(marksOf("A [link with `code` inside](https://x.com/) here")).toEqual([
      [],
      ["link"],
      ["link", "code"],
      ["link"],
      [],
    ]);
  });

  it("restores nested marks in the right order", () => {
    expect(marksOf("x **b *i `c` i* b** y")).toEqual([
      [],
      ["bold"],
      ["bold", "italic"],
      ["code"],
      ["bold", "italic"],
      ["bold"],
      [],
    ]);
  });

  it("keeps a mark's trailing space INSIDE the mark when a code span follows", () => {
    // `**Task **` is not emphasis (the closer must be right-flanking), but
    // `**Task&#32;**` is: the `;` is punctuation and so is the backtick that
    // follows, which satisfies the "preceded AND followed by punctuation" branch.
    // Expelling the space instead moved a mark boundary the live document keeps,
    // so `parse(serialize(live)) !== live` at every such block.
    const d = doc(p(t("Task ", "bold"), t("Spent", "code"), t(" = the evidence")));
    expect(docToMarkdown(d)).toBe("**Task&#32;**`Spent` = the evidence");
    assertDocRoundTrip(d, "bold trailing space before a code span");
  });

  it("keeps a mark's leading space INSIDE the mark when a code span precedes", () => {
    const d = doc(p(t("x", "code"), t(" is the record", "bold"), t(" — yes")));
    expect(docToMarkdown(d)).toBe("`x`**&#32;is the record** — yes");
    assertDocRoundTrip(d, "bold leading space after a code span");
  });

  it("respells the NEIGHBOUR's letter so the mark can keep its trailing space", () => {
    // The closer is preceded by the `;` of `&#32;`, so CommonMark demands
    // punctuation or whitespace after it too — and a letter is neither. Rather
    // than expel the space (which rewrites the document), the letter itself is
    // written as a character reference: `&` is punctuation, the run closes, and
    // `&#116;` decodes straight back to `t`.
    const d = doc(p(t("bold ", "bold"), t("tail")));
    expect(docToMarkdown(d)).toBe("**bold&#32;**&#116;ail");
    assertDocRoundTrip(d, "bold trailing space before plain text");
  });

  it("respells it on the LEADING side too", () => {
    const d = doc(p(t("head"), t(" bold", "bold")));
    expect(docToMarkdown(d)).toBe("hea&#100;**&#32;bold**");
    assertDocRoundTrip(d, "bold leading space after plain text");
  });

  it("leaves an already-punctuated neighbour alone (no gratuitous references)", () => {
    // `.` and `!` already satisfy the flanking rule, so the prettier spelling
    // wins: the repair costs a character reference ONLY where one is needed.
    assertDocRoundTrip(doc(p(t("head."), t(" bold", "bold"))), "punctuation before");
    expect(docToMarkdown(doc(p(t("bold ", "bold"), t("!tail"))))).toBe("**bold&#32;**!tail");
  });

  it("still expels edge whitespace that would FUSE two delimiter runs", () => {
    // `*a&#32;***b**` reads as one run of three asterisks, not as `*a*` + `**b**`,
    // so this stays the documented "boundary moves by one whitespace run" loss.
    const md = docToMarkdown(doc(p(t("a ", "italic"), t("b", "bold"))));
    expect(md).toBe("*a* **b**");
    assertDocRoundTrip(markdownToDoc(md, schema), "italic then bold");
  });

  // -------------------------------------------------------------------------
  // A LINK WHOSE TEXT IS A CODE SPAN keeps its href: `code` excludes only what
  // markdown cannot spell inside backticks.
  // -------------------------------------------------------------------------
  it("keeps the href of a link whose text IS a code span", () => {
    const back = assertMarkdownRoundTrip("See [`x.com`](https://x.com/) here", "code span as link text");
    expect(marksOf("See [`x.com`](https://x.com/) here")).toEqual([[], ["link", "code"], []]);
    // The href reaches the text node — the thing that was being lost.
    const hrefs: (string | null)[] = [];
    back.descendants((n) => {
      for (const m of n.marks) if (m.type.name === "link") hrefs.push(m.attrs.href);
    });
    expect(hrefs).toEqual(["https://x.com/"]);
  });

  it("keeps the title too, and survives from the DOCUMENT side", () => {
    const link = schema.marks.link!.create({ href: "https://x.com/", title: "t" });
    const d = doc(p(t("See "), schema.text("x.com", [link, schema.marks.code!.create()]), t(" here")));
    expect(docToMarkdown(d)).toBe('See [`x.com`](https://x.com/ "t") here');
    assertDocRoundTrip(d, "code span as link text, with title");
  });

  it("nests link OUTSIDE code, never the other way round", () => {
    // Mark RANK decides nesting on export, and `[` `x` `]` is the only spelling
    // markdown has: `` `[x](url)` `` would be a code span containing brackets.
    // link is a priority-1000 extension so it sorts to rank 0; code is mounted
    // after StarterKit so it sorts last (see StugaCode in schema.ts).
    //
    // Rank IS position in the schema's mark list — ProseMirror assigns it by
    // walking `spec.marks` in order — so the public key order states the same
    // fact as the internal `MarkType.rank` field, which is absent from
    // prosemirror-model's published types. `schema.test.ts` pins this order.
    const rank = Object.keys(schema.marks);
    expect(rank.indexOf("link")).toBeLessThan(rank.indexOf("code"));
  });

  it("still refuses emphasis inside a code span", () => {
    // The other half of the contract: markdown CANNOT express these inside
    // backticks, so `code` must keep evicting them. Entered from the document
    // side, because markdown has no syntax that would even propose it.
    for (const m of ["bold", "italic", "strike", "underline"]) {
      // Marking code over emphasis EVICTS the emphasis...
      const evicts = schema.marks.code!.create().addToSet([schema.marks[m]!.create()]);
      expect(evicts.map((x) => x.type.name)).toEqual(["code"]);
      // ...and emphasis over code is simply refused. Either way they never pair.
      const refused = schema.marks[m]!.create().addToSet([schema.marks.code!.create()]);
      expect(refused.map((x) => x.type.name)).toEqual(["code"]);
    }
    // ...while link and code sit on the same node, in rank order.
    const both = schema.marks.code!.create().addToSet([schema.marks.link!.create({ href: "https://x.com/" })]);
    expect(both.map((x) => x.type.name)).toEqual(["link", "code"]);
  });

  it("keeps `**bold `code` bold**` free of any link", () => {
    // The eviction repair must not invent marks: with no link in the source, the
    // span carries `code` alone.
    expect(marksOf("x **b `c` b** y")).toEqual([[], ["bold"], ["code"], ["bold"], []]);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENTED LOSSES — shapes that provably cannot round-trip through GFM. Each
// is pinned so the behaviour is a decision, not drift.
// ---------------------------------------------------------------------------
describe("documented round-trip losses", () => {
  it("underline degrades to plain text (no CommonMark/GFM syntax exists)", () => {
    // WHY IT IS IRREDUCIBLE: CommonMark and GFM have no underline delimiter at
    // all — `__x__` is strong emphasis, not underline — so the only spelling is
    // raw `<u>`/`<ins>` HTML, and the tokenizer runs `html: false` on purpose.
    // Turning HTML on to rescue this ONE mark would let every `<script>`,
    // `<style>` and stray `<div>` in AI-authored markdown through as html_block
    // tokens that this schema has no node for — a much larger class of loss, and
    // a security surface, traded for a mark the editor can express in the CRDT
    // anyway.
    //
    // WHAT IT COSTS: the mark is dropped, the TEXT always survives, and the live
    // document therefore disagrees with its own projection at an underlined
    // block — which the 3-way merge reads as a concurrent human edit, so a hunk
    // overlapping such a block can go unanchored. The projection is a fixed
    // point, so the damage stops there: block COUNT and order are untouched, and
    // every other hunk in the document still anchors.
    const d = doc(p(t("plain "), t("underlined", "underline")));
    const md = docToMarkdown(d);
    expect(md).toBe("plain underlined");
    const back = markdownToDoc(md, schema);
    expect(back.textContent).toBe("plain underlined");
    expect(back.toJSON()).not.toEqual(d.toJSON()); // the loss itself
    expect(docToMarkdown(back)).toBe(md); // ...bounded: a fixed point
    expect(back.childCount).toBe(d.childCount); // ...and no index shift
  });

  it("whitespace between two FUSING emphasis runs moves out of the mark", () => {
    // The residue of the mid-line emphasis-edge problem, now that a text
    // neighbour is respelt as a character reference (see "marks around a code
    // span" above). Here the neighbour is another `*` run, and no spelling of
    // ITS side helps: `*a&#32;***b**` is a single run of three asterisks, which
    // CommonMark pairs from the outside in — `*a&#32;**` + `*b**` — so both
    // readings are wrong. The delimiter characters are the serializer's own, not
    // the document's text, so unlike a letter they cannot be re-encoded at all.
    //
    // The space is expelled from the mark instead: text preserved exactly, one
    // mark boundary shifted by one whitespace run, and the output is a fixed
    // point — which is what keeps block indices, and therefore hunk locations,
    // stable around it.
    const d = doc(p(t("a ", "italic"), t("b", "bold")));
    const md = docToMarkdown(d);
    expect(md).toBe("*a* **b**");
    const back = markdownToDoc(md, schema);
    expect(back.textContent).toBe("a b"); // text intact
    expect(back.toJSON()).not.toEqual(d.toJSON()); // the irreducible loss
    expect(docToMarkdown(back)).toBe(md); // ...and it does not compound
  });

  it("whitespace at an emphasis boundary at a LINE edge is kept, marked", () => {
    // The line edge satisfies the flanking rule, so the character-reference trick
    // works here and the mark keeps its whitespace exactly.
    assertDocRoundTrip(doc(p(t("bold ", "bold"))), "trailing space inside bold");
    assertDocRoundTrip(doc(p(t("  bold", "italic"), t("x"))), "leading space inside italic");
  });

  it("a code span padded with spaces keeps its padding", () => {
    // CommonMark strips one leading AND trailing space from a code span when both
    // are present, so `` ` x ` `` alone would mean "x"; an extra space each side
    // survives the strip exactly.
    const d = doc(p(schema.text(" x ", [schema.marks.code!.create()])));
    expect(docToMarkdown(d)).toBe("`  x  `");
    assertDocRoundTrip(d, "padded code span");
  });

  it("a hard break inside a table cell becomes a space", () => {
    // WHY IT IS IRREDUCIBLE: a GFM row is ONE LINE — the table block rule splits
    // rows on newlines before any inline parsing — so no escape, entity or
    // continuation can put a line break inside a cell. The two spellings that
    // exist are `<br>` (raw HTML, refused: see the underline case above) and a
    // literal `&#10;`, which no other GFM reader turns back into a break: it
    // would make the file's meaning depend on this parser, and the exported
    // markdown is meant to be ordinary GFM.
    //
    // WHAT IT COSTS: the break reads as a space, so the TABLE block disagrees
    // with its projection and a hunk overlapping that table can go unanchored.
    // Bounded the same way as underline: the markdown is a fixed point and the
    // block count is unchanged, so nothing downstream shifts.
    const cellP = schema.nodes.paragraph!.create(null, [t("a"), schema.nodes.hardBreak!.create(), t("b")]);
    const d = doc(
      schema.nodes.table!.create(null, [
        schema.nodes.tableRow!.create(null, [schema.nodes.tableHeader!.create(null, [cellP])]),
        schema.nodes.tableRow!.create(null, [schema.nodes.tableCell!.create(null, [p(t("c"))])]),
      ]),
    );
    const md = docToMarkdown(d);
    expect(md).toContain("| a b |");
    const back = markdownToDoc(md, schema);
    expect(back.textContent).toContain("a b"); // text intact, break spent as a space
    expect(docToMarkdown(back)).toBe(md); // a fixed point…
    expect(back.childCount).toBe(d.childCount); // …with no index shift
  });

  it("a hard break inside a HEADING becomes a space (and never splits the heading)", () => {
    // WHY IT IS IRREDUCIBLE: an ATX heading ends at its newline, so no spelling
    // of a line break can stay INSIDE one — the only container markdown offers
    // for a two-line heading is a setext heading, which has no level above 2 and
    // whose underline this serializer escapes on purpose (see `serializeText`).
    //
    // WHAT IT COSTS: the break reads as a space. The alternative — the stock
    // `hard_break` serializer's `\` + newline — is what this replaced, and it was
    // NOT a bounded loss: the continuation re-parsed as its own paragraph (one
    // top-level block becoming TWO, shifting every block index below it and
    // unanchoring every hunk after it) and the `\` landed as a literal backslash
    // in the heading's text, re-escaped again on the next pass.
    const d = doc(
      schema.nodes.heading!.create({ level: 2 }, [t("Risk"), schema.nodes.hardBreak!.create(), t("register")]),
      p(t("body")),
    );
    const md = docToMarkdown(d);
    expect(md).toBe("## Risk register\n\nbody"); // no `\`, no second line
    const back = markdownToDoc(md, schema);
    expect(back.textContent).toBe("Risk registerbody"); // text intact, break spent as a space
    expect(back.toJSON()).not.toEqual(d.toJSON()); // the loss itself
    expect(docToMarkdown(back)).toBe(md); // a fixed point…
    expect(back.childCount).toBe(d.childCount); // …with no index shift
    expect(back.child(0).type.name).toBe("heading"); // …and the heading stays one block
  });

  it("cells of one column with DIFFERENT alignments collapse to the column's first", () => {
    // WHY IT IS IRREDUCIBLE: GFM spells alignment ONCE PER COLUMN, in the single
    // delimiter row, while Tiptap stores an `align` attr on every cell. A column
    // whose cells disagree is therefore not expressible — there is no second
    // place to put the other answer. The serializer takes the first cell in the
    // column that has any alignment at all and applies it to the column.
    //
    // Unreachable through the editor, whose column-alignment commands set every
    // cell at once; it takes hand-written ProseMirror JSON (or a future per-cell
    // command) to build one.
    const hdr = schema.nodes.tableHeader!.create({ align: "right" }, [p(t("h"))]);
    const body = schema.nodes.tableCell!.create({ align: "left" }, [p(t("b"))]);
    const d = doc(
      schema.nodes.table!.create(null, [
        schema.nodes.tableRow!.create(null, [hdr]),
        schema.nodes.tableRow!.create(null, [body]),
      ]),
    );
    expect(docToMarkdown(d)).toContain("| --: |");
    const back = markdownToDoc(docToMarkdown(d), schema);
    // Both cells come back right-aligned — but the projection is stable, so the
    // block structure (what the merge indexes on) still matches.
    expect(docToMarkdown(back)).toBe(docToMarkdown(d));
    expect(back.childCount).toBe(d.childCount);
  });

  it("a mark wrapping an image is dropped (the image is a BLOCK node here)", () => {
    // WHY IT IS IRREDUCIBLE HERE: marks live on inline nodes, and `image` is a
    // BLOCK node in this schema — `Image.configure({ inline: false })` in
    // apps/web's Editor.tsx, which schema.ts must mirror byte for byte or the
    // CRDT and the editor disagree about the document. So a badge's
    // `[![CI](badge.svg)](ci)` link wrapper has no node to attach to, and the
    // `image` node has no href attr to park it in either. Fixing it is a schema
    // decision spanning both packages, not a serializer one.
    //
    // WHAT IT COSTS: the wrapping mark only. The image and every surrounding
    // character of TEXT survive (before the block-image hoist they did not —
    // the whole paragraph was silently dropped), and the result round-trips
    // exactly, so nothing is unanchored by it.
    const d = markdownToDoc("[![CI](./badge.svg)](https://ci.example.com)", schema);
    const names: string[] = [];
    d.content.forEach((c) => names.push(c.type.name));
    expect(names).toEqual(["image"]);
    assertDocRoundTrip(d, "badge");
  });

  it("a multi-paragraph footnote definition collapses to one line, WORDS INTACT", () => {
    // `footnoteDefinition` is `inline*`, so the paragraphs join; the break becomes a
    // space and no words fuse.
    const d = markdownToDoc("Ref [^1].\n\n[^1]: first para\n\n    second para", schema);
    const defs: string[] = [];
    d.descendants((n) => {
      if (n.type.name === "footnoteDefinition") defs.push(n.textContent);
    });
    expect(defs).toEqual(["first para second para"]);
    // Lossy once, then stable: the collapsed form is its own fixed point.
    assertDocRoundTrip(d, "multi-paragraph footnote");
  });

  it("a multi-paragraph footnote keeps the marks of every paragraph it merges", () => {
    const d = markdownToDoc("Ref [^1].\n\n[^1]: [Source](/doc/x)\n\n    **frozen** excerpt", schema);
    expect(docToMarkdown(d)).toBe("Ref [^1].\n\n[^1]: [Source](/doc/x) **frozen** excerpt");
    assertDocRoundTrip(d, "multi-paragraph footnote with marks");
  });

  it("a list item STARTING with an image keeps a leading empty paragraph", () => {
    // NOT a round-trip loss at all — it round-trips exactly, which is why the
    // assertion below is the full one — but a SHAPE the schema imposes, recorded
    // here so it reads as a decision. `listItem` content is "paragraph block*",
    // so a block image can never be an item's first child and the hoist has to
    // leave an empty paragraph in front of it. The alternative, dropping the
    // image to keep the item tidy, trades content for cosmetics; before the hoist
    // existed the image AND the word "tail" were both destroyed.
    //
    // The empty paragraph is not WRITTEN (a bare `* ` line plus a blank line ends
    // the item, and the image would escape the list); the parser re-creates it
    // from the content spec, which is what closes the loop.
    const d = markdownToDoc("* ![x](./x.png) tail", schema);
    expect(d.textContent).toContain("tail");
    expect(d.firstChild!.type.name).toBe("bulletList");
    expect(docToMarkdown(d)).toBe("* ![x](./x.png)\n\n  tail");
    assertDocRoundTrip(d, "image-leading list item");
  });
  it("keeps a table inside a list item that the serializer indents by four spaces", () => {
    // The serializer indents an ordered list's continuation by `maxW + 2`, so a
    // list with ten or more items writes its table at exactly four spaces — and
    // four spaces is also the indented-code-block threshold. Dedenting on that
    // measurement alone rips the table out of the item it belongs to, splitting
    // the list around it. markdown-it parses the indented form correctly, so
    // there is nothing here for a dedent to repair.
    const cell = (t: string, header = false) =>
      (header ? schema.nodes.tableHeader! : schema.nodes.tableCell!).create(null, [
        schema.nodes.paragraph!.create(null, [schema.text(t)]),
      ]);
    const table = () =>
      schema.nodes.table!.create(null, [
        schema.nodes.tableRow!.create(null, [cell("A", true), cell("B", true)]),
        schema.nodes.tableRow!.create(null, [cell("1"), cell("2")]),
      ]);
    const para = (t: string) => schema.nodes.paragraph!.create(null, [schema.text(t)]);
    const items = Array.from({ length: 11 }, (_, i) =>
      schema.nodes.listItem!.create(null, i === 0 ? [para("one"), table()] : [para(`item ${i + 1}`)]),
    );
    const doc = schema.nodes.doc!.create(null, [
      para("before"),
      schema.nodes.orderedList!.create({ start: 1 }, items),
      para("after"),
    ]);
    assertDocRoundTrip(doc, "table inside a 4-space-indented ordered list item");
  });

  it("keeps a table inside a twice-nested bullet item", () => {
    // Two bullet levels is also four columns of indent, by a different route.
    const md = "* outer\n\n  * inner\n\n    | A | B |\n    | --- | --- |\n    | 1 | 2 |";
    const doc = markdownToDoc(md, schema);
    expect(doc.firstChild!.type.name).toBe("bulletList");
    // The table must still be inside the list, not hoisted to a sibling.
    expect(doc.childCount, "the table escaped the list").toBe(1);
    assertDocRoundTrip(doc, "table inside a twice-nested bullet item");
  });
});

describe("mentions", () => {
  it("parse to a mention node that carries the alias and label", () => {
    const parsed = markdownToDoc("Hi [@first\\_last](mention:auth0%7C123).", schema);
    const node = parsed.firstChild!.child(1);
    expect(node.type.name).toBe("mention");
    expect(node.attrs).toEqual({ alias: "auth0|123", label: "first_last" });
  });

  it("leave any other link a link", () => {
    const parsed = markdownToDoc("[ada](mention:u_ada) and [@ada](https://example.com)", schema);
    const names: string[] = [];
    parsed.descendants((n) => {
      names.push(n.type.name);
    });
    expect(names).not.toContain("mention");
  });
});
