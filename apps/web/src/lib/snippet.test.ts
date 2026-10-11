import { describe, expect, it } from "vitest";
import { HIT_PARAM, foundByMeaning, hitHref, markTerms, passageHint, queryTerms, snippetParts, windowParts, withoutTitle, type SnippetPart } from "./snippet";

/** Half of an emoji or other astral character, which a URL turns into U+FFFD. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("snippetParts", () => {
  it("splits at the highlight sentinels and keeps markup as text", () => {
    expect(snippetParts("a <b>x</b> ⟦where⟧ it\n\n is")).toEqual([
      { text: "a <b>x</b> ", hit: false },
      { text: "where", hit: true },
      { text: " it is", hit: false },
    ]);
  });

  it("drops a Markdown heading's marker, as the page does", () => {
    expect(snippetParts("# Vendor note\n\nWe reviewed the ⟦contract⟧.")).toEqual([
      { text: "Vendor note We reviewed the ", hit: false },
      { text: "contract", hit: true },
      { text: ".", hit: false },
    ]);
  });

  it("survives a snippet cut inside a highlight", () => {
    expect(snippetParts("see ⟦wher")).toEqual([
      { text: "see ", hit: false },
      { text: "wher", hit: true },
    ]);
  });

  it("leaves text without Markdown as it is, in any script", () => {
    expect(snippetParts("Find out ⟦where⟧ things live,\n\n  then (maybe) ask: a_b, AT&T, 5 > 3.")).toEqual([
      { text: "Find out ", hit: false },
      { text: "where", hit: true },
      { text: " things live, then (maybe) ask: a_b, AT&T, 5 > 3.", hit: false },
    ]);
    expect(snippetParts("屋根の⟦修理⟧は来週の月曜日に予定しています")).toEqual([
      { text: "屋根の", hit: false },
      { text: "修理", hit: true },
      { text: "は来週の月曜日に予定しています", hit: false },
    ]);
  });
});

// Indexed Markdown in, the text the page shows out, hits kept.
describe("snippetParts on Markdown", () => {
  /** The excerpt as text, each hit in brackets. */
  const shown = (snippet: string) =>
    snippetParts(snippet)
      .map((p) => (p.hit ? `[${p.text}]` : p.text))
      .join("");

  it("shows a link's label, and moves a hit in its target to the label", () => {
    expect(shown("see [the ⟦runbook⟧ for repairs](https://x.test/a) today")).toBe("see the [runbook] for repairs today");
    expect(shown("read [the upkeep runbook](https://x.test/⟦repairs⟧) before Monday")).toBe("read [the upkeep runbook] before Monday");
    // A hit in both stays where the label has it.
    expect(shown("see [the ⟦runbook⟧](https://x.test/⟦runbook⟧) today")).toBe("see the [runbook] today");
    expect(shown("![⟦repairs⟧ to the roof](roof.png) and the ⟦repairs⟧ list")).toBe("and the [repairs] list");
  });

  it("drops emphasis delimiters, and keeps code as written", () => {
    expect(shown("Book the ⟦repairs⟧ for **May**, _not_ ~~June~~.")).toBe("Book the [repairs] for May, not June.");
    expect(shown("Run `a*b` and `__init__()` before the ⟦contract⟧ check")).toBe("Run a*b and __init__() before the [contract] check");
    expect(shown("a snake_case ⟦repairs⟧ log, and the snake_⟦case⟧ one")).toBe("a snake_case [repairs] log, and the snake_[case] one");
  });

  it("shows a table row's cells, and no delimiter row", () => {
    expect(shown("| Rule | Window |\n|---|:---:|\n| ⟦GDPR⟧ | 72 hours |")).toBe("Rule · Window [GDPR] · 72 hours");
    expect(shown("| `ps aux \\| grep` lists ⟦jobs⟧ |  | 1 |")).toBe("ps aux | grep lists [jobs] · 1");
  });

  it("drops block markers and rules", () => {
    expect(shown("## Week 2\n\n> quoted ⟦repairs⟧ text\n\n- first item\n1. second item\n\n---\n\nEnd.")).toBe(
      "Week 2 quoted [repairs] text first item second item End.",
    );
  });

  it("drops a task item's box with its list marker, and keeps a box written in prose", () => {
    expect(shown("Shopping\n\n* [x] buy flour\n* [ ] buy ⟦butter⟧")).toBe("Shopping buy flour buy [butter]");
    expect(shown("> * [X] ⟦done⟧")).toBe("[done]");
    expect(shown("Tick [x] when ⟦done⟧")).toBe("Tick [x] when [done]");
  });

  it("undoes the serializer's escapes and references", () => {
    expect(shown("Check \\[x\\] the ⟦repairs⟧\\_log with npm&#32;ci")).toBe("Check [x] the [repairs]_log with npm ci");
    // The serializer escapes a `<` that only looks like an autolink.
    expect(shown("the string \\<https://example.com> is not ⟦a⟧ link")).toBe("the string <https://example.com> is not [a] link");
    expect(shown("see <https://x.test/a> for the ⟦repairs⟧")).toBe("see https://x.test/a for the [repairs]");
  });

  it("drops a link the snippet starts or ends inside", () => {
    expect(shown("runbook](https://x.test/a) and the ⟦repairs⟧ list in [the run")).toBe("and the [repairs] list in");
    expect(shown("x.test/a) and the ⟦repairs⟧ list in [the runbook](https://x.te")).toBe("and the [repairs] list in");
  });

  it("keeps a cut link that holds a hit, as its label", () => {
    expect(shown("upkeep runbook](https://x.test/docs/⟦repairs⟧/2026) for May")).toBe("[upkeep runbook] for May");
    expect(shown("the ⟦runbook⟧ for repairs](https://x.test/a) today")).toBe("the [runbook] for repairs today");
    expect(shown("the list in [the ⟦runbook⟧")).toBe("the list in the [runbook]");
    expect(shown("the list in [the runbook](https://x.test/⟦repairs⟧")).toBe("the list in [the runbook]");
    // No label is left to carry it.
    expect(shown("docs/⟦repairs⟧/2026) for May")).toBe("docs/[repairs]/2026 for May");
  });

  it("drops a cut target whose parentheses are escaped, and keeps a hit's own word before a parenthesis", () => {
    const text = (s: string) => snippetParts(s).map((p) => (p.hit ? `[${p.text}]` : p.text)).join("");
    expect(text("Python_\\(programming_language\\)) and the ⟦repairs⟧ list for May")).toBe("and the [repairs] list for May");
    expect(passageHint("Python_\\(programming_language\\)) and the ⟦repairs⟧ list for May")).toBe("and the repairs list for May");
    expect(text("⟦everyone⟧) writes crappy first drafts")).toBe("[everyone]) writes crappy first drafts");
    expect(passageHint("⟦everyone⟧) writes crappy first drafts")).toBe("everyone) writes crappy first");
  });

  it("shows a quoted code block without the quote's markers, and plain code's prompt as written", () => {
    const text = (s: string) => snippetParts(s).map((p) => p.text).join("");
    expect(text("> ```python\n> x = a*b  # the ⟦zebra⟧\n> ```")).toBe("x = a*b # the zebra");
    // The server opens an excerpt cut inside a quoted block with a fence in the quote.
    expect(text("> ```\n> y = 1  # ⟦zebra⟧\n> ```\n\nAfter.")).toBe("y = 1 # zebra After.");
    expect(text("```\n>>> ⟦print⟧(1)\n```")).toBe(">>> print(1)");
  });

  it("reads an autolink after an escaped backslash, and not an escaped one", () => {
    const text = (s: string) => snippetParts(s).map((p) => p.text).join("");
    expect(text("See \\\\<https://x.test/a> now")).toBe("See \\https://x.test/a now");
    expect(text("See \\<https://x.test/a> now")).toBe("See <https://x.test/a> now");
  });

  it("keeps prose that closes a parenthesis at the start, and drops a cut target", () => {
    expect(shown("⟦๖⟧) และ (๘) อาจยกเว้น")).toBe("[๖]) และ (๘) อาจยกเว้น");
    expect(shown("平成十五年法律第五十七号)の⟦改正⟧について")).toBe("平成十五年法律第五十七号)の[改正]について");
    expect(shown("⟦포함한다⟧)에 따른 출입")).toBe("[포함한다])에 따른 출입");
    // A file name is a target, in any script.
    expect(shown("個人情報.md)の⟦改正⟧について")).toBe("の[改正]について");
    // A plain ASCII word is too: most are a cut link's, and dropping one costs the excerpt a word.
    expect(shown("brief.md) and the ⟦repairs⟧ list")).toBe("and the [repairs] list");
    expect(shown("plan) and the ⟦repairs⟧ list")).toBe("and the [repairs] list");
  });

  it("closes a code span the snippet starts or ends inside, so the spans between pair as on the page", () => {
    expect(shown("globals()` and `__dict__` return the raw ⟦namespace⟧")).toBe("globals() and __dict__ return the raw [namespace]");
    expect(shown("case_name` before the ⟦contract⟧ check. Use `` `tick` `` in code.")).toBe(
      "case_name before the [contract] check. Use `tick` in code.",
    );
    expect(shown("the ⟦raw⟧ `dict` namespace\nand the `__dict__` and `__init")).toBe("the [raw] dict namespace and the __dict__ and __init");
    // On a line that both starts and ends the snippet, the reading whose spans fit wins.
    expect(shown("the ⟦raw⟧ `dict` namespace and the `__ini")).toBe("the [raw] dict namespace and the __ini");
  });

  it("keeps link syntax inside cut code as written, and drops a link around it", () => {
    expect(shown("key]` and the ⟦repairs⟧ list")).toBe("key] and the [repairs] list");
    expect(shown("see the ⟦repairs⟧ list in `arr[i")).toBe("see the [repairs] list in arr[i");
    expect(shown("foo` runbook](https://x.test/a) and the ⟦repairs⟧ list")).toBe("and the [repairs] list");
    expect(shown("see the ⟦repairs⟧ list in [the `fo")).toBe("see the [repairs] list in");
  });

  it("shows a fenced code block's lines as written, without its fences", () => {
    expect(shown("Intro.\n\n```js\nconst x = a*b; // the ⟦contract⟧\n```\n\nAfter **that**.")).toBe(
      "Intro. const x = a*b; // the [contract] After that.",
    );
    // A snippet can start inside a code block; a blank line after its closing fence starts prose again.
    expect(shown("x = a*b\n```\n\nBook the ⟦contract⟧ for **May**.")).toBe("x = a*b Book the [contract] for May.");
    // The server opens one that starts inside a block with a fence of its own.
    expect(shown("```\nclass Foo:\n    def __iter__(self):  # the ⟦contract⟧ loop")).toBe("class Foo: def __iter__(self): # the [contract] loop");
    expect(shown("```\nx = a*b\n```\n\nBook the ⟦contract⟧ for **May**.")).toBe("x = a*b Book the [contract] for May.");
  });
});

describe("windowParts", () => {
  it("cuts the text before the first hit at a word, marking the cut", () => {
    const parts = snippetParts(`${"lorem ipsum ".repeat(10)}dolor ⟦where⟧ next`);
    const [lead, hit] = windowParts(parts, 20) as [SnippetPart, SnippetPart];
    expect(lead.text.startsWith("…")).toBe(true);
    expect(lead.text.length).toBeLessThanOrEqual(21);
    expect(lead.text).toMatch(/^…\w/);
    expect(hit).toEqual({ text: "where", hit: true });
  });

  it("leaves a short lead and a snippet without a hit alone", () => {
    const short = snippetParts("short ⟦where⟧");
    expect(windowParts(short, 20)).toBe(short);
    const none = snippetParts("x ".repeat(50));
    expect(windowParts(none, 20)).toBe(none);
  });

  it("never cuts an emoji in half", () => {
    const [lead] = windowParts(snippetParts(`${"🎉".repeat(20)}⟦where⟧`), 21) as [SnippetPart];
    expect(lead.text).not.toMatch(LONE_SURROGATE);
  });
});

describe("markTerms", () => {
  it("marks every case-insensitive occurrence of the query's words", () => {
    expect(markTerms("Where is WHERE", queryTerms("where"))).toEqual([
      { text: "Where", hit: true },
      { text: " is ", hit: false },
      { text: "WHERE", hit: true },
    ]);
  });

  it("skips one-letter Latin words but keeps a single CJK character", () => {
    expect(queryTerms("a tax 税")).toEqual(["tax", "税"]);
  });

  it("treats the query as text, not a pattern", () => {
    expect(markTerms("costs (2026)", queryTerms("(2026)"))).toEqual([
      { text: "costs ", hit: false },
      { text: "(2026)", hit: true },
    ]);
  });
});

// Indexed Markdown in, the text the editor renders out: the hint has to be found in one rendered block.
describe("passageHint", () => {
  it("keeps a few words either side of the first hit, without Markdown", () => {
    const snippet = "Turn the listed **⟦repairs⟧** into dated jobs, see [the runbook](https://example.com/⟦repairs⟧).";
    expect(passageHint(snippet)).toBe("Turn the listed repairs into dated jobs, see");
  });

  it("stays on the hit's own line, which is one block", () => {
    const snippet = "# Upkeep\n\nAn introduction.\n\n## Week 2\n\nTurn the listed ⟦repairs⟧ into jobs.\n\nNext block.";
    expect(passageHint(snippet)).toBe("Turn the listed repairs into jobs.");
  });

  it("drops block markers: heading, list item, numbered item, quote", () => {
    expect(passageHint("## Week 2 — ⟦Repairs⟧\n\nTurn the listed repairs")).toBe("Week 2 — Repairs");
    expect(passageHint("- first item about ⟦gutters⟧\n- second item")).toBe("first item about gutters");
    expect(passageHint("1. call the roofer about ⟦repairs⟧")).toBe("call the roofer about repairs");
    expect(passageHint("> quoted ⟦repairs⟧ text here")).toBe("quoted repairs text here");
  });

  it("keeps to the hit's table cell, which renders as its own block", () => {
    const table = "| Item | Cost |\n| --- | --- |\n| Roof ⟦repairs⟧ and gutters | 1200 |";
    expect(passageHint(table)).toBe("Roof repairs and gutters");
    // A short cell is too short to tell from a chance match.
    expect(passageHint("| Item | Cost |\n| ⟦Roof⟧ | 1200 |")).toBeNull();
  });

  it("keeps a link's label, and moves a hit in its target to the label", () => {
    expect(passageHint("see [the ⟦runbook⟧ for repairs](https://x.test/a) today")).toBe("see the runbook for repairs today");
    expect(passageHint("read [the upkeep runbook](https://x.test/⟦repairs⟧) before Monday")).toBe(
      "read the upkeep runbook before Monday",
    );
  });

  it("gives nothing for a hit the page does not show as text", () => {
    expect(passageHint("![⟦repairs⟧ to the roof](roof.png)")).toBeNull();
  });

  it("finds a task item's words without its box", () => {
    expect(passageHint("* [x] buy flour\n* [ ] buy the ⟦butter⟧ from the market")).toBe("buy the butter from the market");
  });

  it("undoes the serializer's escapes and references", () => {
    expect(passageHint("Check \\[x\\] the ⟦repairs⟧\\_log with npm&#32;ci")).toBe("Check [x] the repairs log with npm ci");
  });

  it("drops emphasis and code delimiters without leaving a space the page does not have", () => {
    expect(passageHint("Book the ⟦repairs⟧ for **May**.")).toBe("Book the repairs for May.");
    expect(passageHint("Run `npm ci`, then ⟦repairs⟧.")).toBe("Run npm ci, then repairs.");
    // A bare `_` inside a word is literal; stripped, as the page's text is when matched.
    expect(passageHint("a snake_case ⟦repairs⟧ log")).toBe("a snake case repairs log");
    expect(passageHint("the snake_⟦case⟧ name is used here")).toBe("the snake case name is used here");
  });

  it("keeps code as written, stripped as the page's text is when matched", () => {
    expect(passageHint("Call `__init__()` first, then the ⟦contract⟧ setup runs")).toBe("init () first, then the contract setup runs");
    expect(passageHint("Compute `a*b` before the ⟦contract⟧ check")).toBe("Compute a b before the contract check");
    expect(passageHint("Intro.\n\n```\nresult = a*b  # the ⟦contract⟧ value here\n```")).toBe("result = a b # the contract value here");
    // A snippet can start inside a code block; a blank line after its closing fence starts prose again.
    expect(passageHint("x = a*b\n```\n\nBook the ⟦contract⟧ for **May**.")).toBe("Book the contract for May.");
    // Code can hold blank lines of its own.
    expect(passageHint("```\ndef f():\n    x = 1\n\n    return a*b  # the ⟦contract⟧ value\n```")).toBe("return a b # the contract value");
    // The server opens a snippet that starts inside a block with a fence of its own.
    expect(passageHint("```\nclass Foo:\n    def __iter__(self):  # the ⟦contract⟧ loop")).toBe("def iter (self): # the contract loop");
    // A snippet can start inside a code span; its backticks close it.
    expect(passageHint("case_name` before the ⟦contract⟧ check; the snake_case variable stays. Use `` `tick` `` in code.")).toBe(
      "case name before the contract check; the snake case",
    );
    // A table cell's pipes are escaped, inside code spans too; the page shows them bare.
    expect(passageHint("| `ps aux \\| grep x` lists the ⟦contract⟧ jobs | 1 |")).toBe("ps aux grep x lists the contract jobs");
  });

  it("drops a link the snippet starts or ends inside", () => {
    expect(passageHint("runbook](https://x.test/a) and the ⟦repairs⟧ list for May")).toBe("and the repairs list for May");
    expect(passageHint("x.test/a) and the ⟦repairs⟧ list for May")).toBe("and the repairs list for May");
    expect(passageHint("the ⟦repairs⟧ list for May in [the run")).toBe("the repairs list for May in");
    expect(passageHint("the ⟦repairs⟧ list for May in [the runbook](https://x.te")).toBe("the repairs list for May in");
    expect(passageHint("upkeep runbook](https://x.test/docs/⟦repairs⟧/2026/may")).toBeNull();
    // An open parenthesis is prose unless a label closes right before it.
    expect(passageHint("Ends with a note (the ⟦contract⟧ renewal is due in")).toBe("Ends with a note (the contract renewal is due in");
    // A closing one ends prose too, unless the word before it reads as a target.
    expect(passageHint("⟦๖⟧) และ (๘) อาจยกเว้น")).toBe("๖) และ (๘) อาจยกเว้น");
    expect(passageHint("平成十五年法律第五十七号)の⟦改正⟧について")).toBe("平成十五年法律第五十七号)の改正について");
    // Matching strips a link inside code too, so a cut one goes whole.
    expect(passageHint("see the ⟦repairs⟧ list in `[x](y")).toBe("see the repairs list in");
    expect(passageHint("x](y)` and the ⟦repairs⟧ list for May")).toBe("and the repairs list for May");
  });

  it("cuts long context at words, and text without spaces by characters", () => {
    const hint = passageHint(`${"lorem ipsum ".repeat(10)}dolor ⟦repairs⟧ sit amet ${"consectetur ".repeat(10)}`)!;
    expect(hint).toMatch(/^\w+ .* dolor repairs sit amet consectetur/);
    expect(hint.length).toBeLessThanOrEqual(24 + "repairs".length + 24);
    expect(passageHint("屋根の⟦修理⟧は来週の月曜日に予定しています")).toBe("屋根の修理は来週の月曜日に予定しています");
  });

  it("never cuts an emoji or other astral character in half, which the link could not carry", () => {
    const snippet = `${"𠮷".repeat(16)}野家の⟦契約⟧は来週の月曜日${"🎉".repeat(13)}`;
    const hint = passageHint(snippet)!;
    expect(hint).toMatch(/^𠮷+野家の契約は来週の月曜日🎉+$/u);
    const url = new URL(hitHref("d1", { title: "Upkeep", snippet }, "契約"), "https://x.test");
    expect(url.searchParams.get(HIT_PARAM)).toBe(hint);
  });

  it("gives nothing without a keyword hit, or when too short to be told from chance", () => {
    expect(passageHint("A passage close in meaning, with no highlight.")).toBeNull();
    expect(passageHint("")).toBeNull();
    expect(passageHint("⟦tax⟧ due")).toBeNull();
  });

  it("never falls back to the hit word alone", () => {
    expect(passageHint("⟦internationalization⟧")).toBeNull();
    expect(passageHint("## ⟦Internationalization⟧.\n\nMore text follows here.")).toBeNull();
  });

  it("survives a snippet cut inside the hit, and marks only the first", () => {
    expect(passageHint("the listed ⟦repai")).toBe("the listed repai");
    expect(passageHint("the listed ⟦repairs⟧ and ⟦repairs⟧ again")).toBe("the listed repairs and repairs again");
  });
});

describe("hitHref", () => {
  const hit = { title: "Upkeep", snippet: "Turn the listed **⟦repairs⟧** into dated jobs." };

  it("opens the document at the matched passage", () => {
    const url = new URL(hitHref("d1", hit, "repairs"), "https://x.test");
    expect(url.pathname).toBe("/doc/d1");
    expect(url.searchParams.get(HIT_PARAM)).toBe("Turn the listed repairs into dated jobs.");
  });

  it("opens at the top when the title holds a query word, as switching documents does", () => {
    expect(hitHref("d1", { ...hit, title: "Roof Repairs" }, "repairs")).toBe("/doc/d1");
    expect(hitHref("d1", { ...hit, title: "Roof repairs" }, "REPAIRS roof")).toBe("/doc/d1");
    expect(hitHref("d1", { ...hit, title: "Roof Repairs" }, "repair")).toBe("/doc/d1");
    expect(hitHref("d1", { title: "屋根の修理", snippet: "屋根の⟦修理⟧は来週の月曜日に予定しています" }, "修理")).toBe("/doc/d1");
  });

  it("counts a query word right after text written without spaces", () => {
    expect(hitHref("d1", { ...hit, title: "使用Docker部署" }, "docker")).toBe("/doc/d1");
    expect(hitHref("d1", { ...hit, title: "社内のKubernetes運用" }, "kubernetes")).toBe("/doc/d1");
  });

  it("does not count a query word inside a title word", () => {
    // "to" is inside "history", "in" inside "Maintenance", "hooks" inside "Webhooks".
    expect(hitHref("d1", { ...hit, title: "Upkeep history" }, "repairs to")).toMatch(`?${HIT_PARAM}=`);
    expect(hitHref("d1", { ...hit, title: "Maintenance" }, "repairs in")).toMatch(`?${HIT_PARAM}=`);
    expect(hitHref("d1", { ...hit, title: "使用Webhooks" }, "hooks")).toMatch(`?${HIT_PARAM}=`);
  });

  it("is a plain link when there is nothing to land on", () => {
    expect(hitHref("d1", { title: "Upkeep", snippet: "A passage close in meaning." }, "fixing")).toBe("/doc/d1");
    expect(hitHref("d1", { title: "Upkeep", snippet: "⟦tax⟧ due" }, "tax")).toBe("/doc/d1");
  });

  it("encodes text that would otherwise break the URL", () => {
    const href = hitHref("a/b", { title: "Upkeep", snippet: "Costs & fees #2 for ⟦repairs⟧ in Q3?" }, "repairs");
    const url = new URL(href, "https://x.test");
    expect(url.pathname).toBe("/doc/a%2Fb");
    expect(url.hash).toBe("");
    expect(url.searchParams.get(HIT_PARAM)).toBe("Costs & fees #2 for repairs in Q3?");
  });
});

describe("withoutTitle", () => {
  const text = (parts: SnippetPart[]) => parts.map((p) => p.text).join("");

  it("drops the title an opening repeats as its heading", () => {
    expect(text(withoutTitle(snippetParts("# Price list 2026\n\n| Item | Price |\n|---|---|\n| Loaf | 6.50 |"), "Price list 2026"))).toBe(
      "Item · Price Loaf · 6.50",
    );
  });

  it("keeps the highlights after it, and a title that is only the start of a word", () => {
    expect(withoutTitle(snippetParts("Croissant recipe Laminate the ⟦dough⟧."), "croissant  recipe")).toEqual([
      { text: "Laminate the ", hit: false },
      { text: "dough", hit: true },
      { text: ".", hit: false },
    ]);
    expect(text(withoutTitle(snippetParts("Price lists are out."), "Price list"))).toBe("Price lists are out.");
    expect(text(withoutTitle(snippetParts("Our prices went up."), "Price list"))).toBe("Our prices went up.");
  });

  it("cuts at the title's own length when lowercasing would lengthen it", () => {
    expect(text(withoutTitle(snippetParts("İzmir notes: the ferry leaves at nine."), "İzmir notes"))).toBe("the ferry leaves at nine.");
  });
});

describe("snippetParts at a cut", () => {
  it("drops a character reference the excerpt's end cut", () => {
    expect(snippetParts("Ben: ok will do&#32")).toEqual([{ text: "Ben: ok will do", hit: false }]);
    expect(snippetParts("Ben: ok will do&#32;")).toEqual([{ text: "Ben: ok will do", hit: false }]);
  });
});

describe("foundByMeaning", () => {
  const hit = (title: string, snippet: string, sem_score = 0.4) => ({ title, snippet, sem_score });

  it("is a hit near in meaning with no highlighted word", () => {
    expect(foundByMeaning(hit("Shopping list", "Butter, flour, eggs."), "cheap")).toBe(true);
  });

  it("is not a hit whose words matched, in the excerpt or the title, or one not near in meaning", () => {
    expect(foundByMeaning(hit("Notes", "It is ⟦cheap⟧ here."), "cheap")).toBe(false);
    expect(foundByMeaning(hit("Cheap eats", "Butter, flour."), "cheap")).toBe(false);
    expect(foundByMeaning(hit("Croissant recipe", "Laminate the dough.", 0), "croisant")).toBe(false);
  });
});
