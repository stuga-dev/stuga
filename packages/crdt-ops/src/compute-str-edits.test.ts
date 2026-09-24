import { describe, it, expect } from "vitest";
import { computeStrEdits, applyStrEdits, applyStrEditsStrict } from "./diff/str-edits.js";
import { markdownToDoc } from "./markdown/parse.js";
import { docToMarkdown } from "./markdown/serialize.js";
import { getStugaSchema } from "./schema.js";

/**
 * Serializer-canonical markdown, i.e. what the document actually holds: every
 * document written through the bridge is `docToMarkdown` output (`*` bullets,
 * blank lines between list items, escaped `[ ]`), and hunks anchor on that text.
 * Writing the fixtures by hand instead would test a form the app never stores.
 */
function canon(md: string): string {
  const schema = getStugaSchema();
  return docToMarkdown(markdownToDoc(md, schema));
}

/** Exact occurrence count (plain indexOf loop, same as the generator's check). */
function count(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    n++;
    at = haystack.indexOf(needle, at + 1);
  }
  return n;
}

/**
 * Assert the FULL computeStrEdits contract for one base→next pair:
 *  - round-trip identity: applyStrEdits(base, edits) === next (the acceptance bar),
 *  - every non-empty old_string occurs EXACTLY ONCE at the time it is applied,
 *  - every non-empty old_string ALSO occurs exactly once in the untouched `base`,
 *    so any single hunk can be accepted or rejected on its own, in any order —
 *    which is precisely what the server does with one hunk_id, and what the
 *    review overlay does when it paints each hunk against the live document,
 *  - an empty old_string only ever appears when the working doc is empty.
 * Returns the edits so callers can add shape-specific assertions.
 *
 * Asserting the base-uniqueness half HERE rather than in one dedicated test is
 * deliberate: it turns every fixture and every fuzz case in this file into a
 * check of it, which is how the weaker "unique when its hunk runs" guarantee got
 * to masquerade as the stronger one for so long.
 */
function roundTrip(base: string, next: string) {
  const edits = computeStrEdits(base, next);
  let working = base;
  edits.forEach((e, i) => {
    if (e.old_string === "") {
      expect(working).toBe("");
      working = working + e.new_string;
      return;
    }
    expect(count(working, e.old_string), `hunk ${i} is not unique when it runs`).toBe(1);
    expect(count(base, e.old_string), `hunk ${i} does not stand alone in the baseline`).toBe(1);
    const at = working.indexOf(e.old_string);
    working = working.slice(0, at) + e.new_string + working.slice(at + e.old_string.length);
  });
  expect(working).toBe(next);
  expect(applyStrEdits(base, edits)).toBe(next);
  return edits;
}

describe("computeStrEdits round-trip identity", () => {
  it("returns [] when the documents are identical", () => {
    expect(computeStrEdits("# Same\n\nBody.", "# Same\n\nBody.")).toEqual([]);
    expect(computeStrEdits("", "")).toEqual([]);
  });

  it("single paragraph edit", () => {
    const base = "# Title\n\nThe quick brown fox.\n\nUnchanged tail.";
    const next = "# Title\n\nThe quick red fox.\n\nUnchanged tail.";
    const edits = roundTrip(base, next);
    // Surgical: the untouched heading/tail should not be part of the hunk.
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("The quick brown fox.");
    expect(edits[0]!.new_string).toBe("The quick red fox.");
  });

  it("multi-block edit (two separated changes → two hunks)", () => {
    const base = "# Title\n\nFirst paragraph.\n\nMiddle stays.\n\nLast paragraph.";
    const next = "# Title\n\nFirst paragraph, edited.\n\nMiddle stays.\n\nLast paragraph, also edited.";
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(2);
  });

  it("pure insertion at the start", () => {
    const base = "First block.\n\nSecond block.";
    const next = "Brand new intro.\n\nFirst block.\n\nSecond block.";
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    // Anchored to the following eq block, inserted text in document order.
    expect(edits[0]!.old_string).toBe("First block.");
    expect(edits[0]!.new_string).toBe("Brand new intro.\n\nFirst block.");
  });

  it("pure insertion in the middle", () => {
    const base = "First block.\n\nSecond block.";
    const next = "First block.\n\nInserted middle.\n\nSecond block.";
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    // Anchored to the PRECEDING eq block.
    expect(edits[0]!.old_string).toBe("First block.");
    expect(edits[0]!.new_string).toBe("First block.\n\nInserted middle.");
  });

  it("pure insertion at the end", () => {
    const base = "First block.\n\nSecond block.";
    const next = "First block.\n\nSecond block.\n\nAppended outro.";
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("Second block.");
    expect(edits[0]!.new_string).toBe("Second block.\n\nAppended outro.");
  });

  it("deletion of a block stays SURGICAL (no whole-doc escalation)", () => {
    // A bare {old: block, new: ""} would leave both separators behind; the deletion
    // anchors on the following block so its separator goes too.
    const base = "Keep one.\n\nDelete me.\n\nKeep two.";
    const next = "Keep one.\n\nKeep two.";
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("Delete me.\n\n");
    expect(edits[0]!.new_string).toBe("");
  });

  it("deletion of the FIRST block is just that block", () => {
    const edits = roundTrip("One.\n\nTwo.\n\nThree.", "Two.\n\nThree.");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("One.\n\n");
    expect(edits[0]!.new_string).toBe("");
  });

  it("deletion of the LAST block carries its leading separator", () => {
    // No following block to borrow from, so the preceding one anchors it; the
    // separator has to be inside the hunk or it would be left dangling.
    const edits = roundTrip("One.\n\nTwo.\n\nThree.", "One.\n\nTwo.");
    expect(edits).toHaveLength(1);
    expect(applyStrEdits("One.\n\nTwo.\n\nThree.", edits)).toBe("One.\n\nTwo.");
  });

  it("an edit PLUS a deletion stays two independent hunks", () => {
    const base = "A one.\n\nB two.\n\nC three.\n\nD four.";
    const next = "A one, edited.\n\nB two.\n\nD four.";
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(2);
    // Neither hunk may span the whole document.
    for (const e of edits) expect(e.old_string.length).toBeLessThan(base.length);
  });

  it("deletion of everything", () => {
    roundTrip("Only paragraph.", "");
    roundTrip("# H\n\nBody one.\n\nBody two.", "");
  });

  it("heading level change", () => {
    const base = "# Top\n\nBody text.\n\n## Section\n\nMore text.";
    const next = "# Top\n\nBody text.\n\n### Section\n\nMore text.";
    roundTrip(base, next);
  });

  it("list restructure", () => {
    const base = "Intro.\n\n- alpha\n\n- beta\n\n- gamma\n\nOutro.";
    const next = "Intro.\n\n1. alpha\n\n2. gamma\n\n3. delta\n\nOutro.";
    roundTrip(base, next);
  });

  it("table edit", () => {
    const base = "Before the table.\n\n| Name | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |\n\nAfter the table.";
    const next = "Before the table.\n\n| Name | Qty |\n| --- | --- |\n| Apples | 7 |\n| Pears | 5 |\n\nAfter the table.";
    roundTrip(base, next);
  });

  it("repeated identical paragraphs — context must grow until unique", () => {
    const para = "Totally identical paragraph.";
    const base = [para, para, para].join("\n\n");
    const next = [para, "The edited middle one.", para].join("\n\n");
    const edits = roundTrip(base, next);
    // The bare paragraph occurs 3× in base — every emitted old_string must have
    // grown enough context to be unique (roundTrip already asserts this; here we
    // additionally pin that it did NOT fall back to matching the ambiguous text).
    for (const e of edits) expect(e.old_string).not.toBe(para);
  });

  it("repeated paragraphs — edit to the LAST of several duplicates", () => {
    const para = "Repeat after me.";
    const base = [para, para, para, "Tail."].join("\n\n");
    const next = [para, para, "Changed third.", "Tail."].join("\n\n");
    roundTrip(base, next);
  });

  it("empty base — insertion into an empty doc uses old_string \"\"", () => {
    const next = "# Fresh doc\n\nFirst content.";
    const edits = roundTrip("", next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("");
    expect(edits[0]!.new_string).toBe(next);
  });

  it("complete rewrite — collapses to a single whole-doc hunk", () => {
    const base = "# Old world\n\nEverything here is different.\n\n- gone\n\n- soon";
    const next = "# New world\n\nNothing survived the rewrite.\n\n> a quote instead";
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe(base);
    expect(edits[0]!.new_string).toBe(next);
  });

  it("CRLF line endings still round-trip exactly", () => {
    const base = "# Title\r\n\r\nA paragraph.\r\n\r\nAnother one.";
    const next = "# Title\r\n\r\nA paragraph, edited.\r\n\r\nAnother one.";
    roundTrip(base, next);
  });

  it("trailing-newline variance still round-trips exactly", () => {
    roundTrip("A paragraph.\n\nSecond.\n", "A paragraph, edited.\n\nSecond.\n");
    roundTrip("A paragraph.\n\nSecond.", "A paragraph.\n\nSecond.\n");
    roundTrip("No newline here.", "No newline here, edited.\n");
  });

  it("markdown that normalizes on parse (non-canonical syntax) still round-trips", () => {
    // `*` bullets serialize back as `-`, so block hunks can't anchor literally —
    // the generator must detect that and fall back rather than emit dead edits.
    const base = "* one\n* two\n* three";
    const next = "* one\n* two\n* three\n* four";
    roundTrip(base, next);
  });

  it("uniqueness is checked at APPLY time, not just against base", () => {
    // The first edit introduces text that duplicates a later target's context.
    const base = "Alpha.\n\nBravo.\n\nCharlie.";
    const next = "Bravo.\n\nBravo!\n\nCharlie.";
    roundTrip(base, next);
  });
});

/** Hunks cover the changed lines and nothing else, so one item of a list can be accepted and another rejected. */
/** Every emitted old_string+new_string must leave `absent` untouched. */
function expectNoneMention(edits: { old_string: string; new_string: string }[], absent: string[]) {
  for (const e of edits) {
    for (const text of absent) {
      expect(e.old_string).not.toContain(text);
      expect(e.new_string).not.toContain(text);
    }
  }
}

/** Deterministic xorshift PRNG, so a failure is reproducible. */
function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return Math.abs(s) / 2 ** 31;
  };
}

describe("computeStrEdits minimality inside container blocks", () => {
  const CHECKLIST = canon(
    [
      "## Ready to Start",
      "",
      "- [ ] Task is Walked and estimated in points (§4.4)",
      "- [ ] Finish checks are written",
      "- [ ] Materials are ordered",
      "- [ ] Photos are attached",
      "- [ ] Safety plan agreed",
      "- [ ] Owner assigned",
      "",
      "Tail paragraph.",
    ].join("\n"),
  );

  it("removing ONE item from a six-item checklist touches only that line", () => {
    const next = CHECKLIST.split("\n\n")
      .filter((b) => !b.includes("Task is Walked"))
      .join("\n\n");
    const edits = roundTrip(CHECKLIST, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("* \\[ \\] Task is Walked and estimated in points (§4.4)\n\n");
    expect(edits[0]!.new_string).toBe("");
    // None of the five surviving bullets — nor the heading/tail — is in the hunk.
    expectNoneMention(edits, [
      "Finish checks",
      "Materials are ordered",
      "Photos are attached",
      "Safety plan",
      "Owner assigned",
      "Ready to Start",
      "Tail paragraph",
    ]);
  });

  it("removing a MIDDLE item carries no context from either side", () => {
    // The reported case removed the 5th of six bullets. Position matters: with
    // unchanged items both before AND after it, `minimizeHunk` has a common
    // prefix and a common suffix to trim, and the item's own line is already
    // unique — so neither neighbour may be dragged into the hunk.
    const next = CHECKLIST.split("\n\n")
      .filter((b) => !b.includes("Safety plan agreed"))
      .join("\n\n");
    const edits = roundTrip(CHECKLIST, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("* \\[ \\] Safety plan agreed\n\n");
    expect(edits[0]!.new_string).toBe("");
    expectNoneMention(edits, [
      "Task is Walked",
      "Finish checks",
      "Materials are ordered",
      "Photos are attached",
      "Owner assigned",
      "Ready to Start",
      "Tail paragraph",
    ]);
  });

  it("editing ONE item's text touches only that line", () => {
    const next = CHECKLIST.replace("Photos are attached", "Photos are attached and reviewed");
    const edits = roundTrip(CHECKLIST, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("* \\[ \\] Photos are attached\n");
    expect(edits[0]!.new_string).toBe("* \\[ \\] Photos are attached and reviewed\n");
    expectNoneMention(edits, ["Task is Walked", "Finish checks", "Owner assigned", "Tail paragraph"]);
  });

  it("adding an item mid-list anchors on ONE neighbouring item", () => {
    const next = CHECKLIST.replace(
      "* \\[ \\] Materials are ordered",
      "* \\[ \\] Materials are ordered\n\n* \\[ \\] Hazards are logged",
    );
    const edits = roundTrip(CHECKLIST, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.new_string).toContain("Hazards are logged");
    expectNoneMention(edits, ["Task is Walked", "Safety plan", "Owner assigned", "Tail paragraph"]);
  });

  it("TWO edits in ONE list are two independently reviewable hunks", () => {
    // The whole point of per-item granularity: the reviewer must be able to take
    // one and leave the other. One list-sized hunk makes that impossible.
    const next = CHECKLIST.replace("Owner assigned", "Owner assigned (by name)").replace(
      "Safety plan agreed",
      "Safety plan signed off",
    );
    const edits = roundTrip(CHECKLIST, next);
    expect(edits).toHaveLength(2);
    for (const e of edits) expect(e.old_string.length).toBeLessThan(CHECKLIST.length / 2);
    expectNoneMention(edits, ["Task is Walked", "Finish checks", "Ready to Start"]);
    // Either one alone still applies cleanly (unique against the base document).
    for (const e of edits) expect(applyStrEditsStrict(CHECKLIST, [e]).conflicts).toEqual([]);
  });

  it("reordering a list stays surgical", () => {
    const base = canon("Intro.\n\n- Alpha item\n- Beta item\n- Gamma item\n\nOutro.");
    const next = canon("Intro.\n\n- Gamma item\n- Alpha item\n- Beta item\n\nOutro.");
    const edits = roundTrip(base, next);
    expectNoneMention(edits, ["Intro.", "Outro."]);
  });

  it("a nested (indented) list marks only the inner item", () => {
    const base = canon("- outer one\n  - inner a\n  - inner b\n- outer two");
    const next = canon("- outer one\n  - inner a\n  - inner b REVISED\n- outer two");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("  * inner b\n");
    expect(edits[0]!.new_string).toBe("  * inner b REVISED\n");
    expectNoneMention(edits, ["outer one", "outer two", "inner a"]);
  });

  it("changing ONE table cell rewrites only that row", () => {
    const base = canon("Intro.\n\n| Name | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |\n\nOutro.");
    const next = canon("Intro.\n\n| Name | Qty |\n| --- | --- |\n| Apples | 7 |\n| Pears | 5 |\n\nOutro.");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("| Apples | 3 |\n");
    expect(edits[0]!.new_string).toBe("| Apples | 7 |\n");
    expectNoneMention(edits, ["Pears", "Intro.", "Outro."]);
  });

  it("removing ONE table row leaves the header and the other rows alone", () => {
    const base = canon("| Name | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |\n| Plums | 9 |");
    const next = canon("| Name | Qty |\n| --- | --- |\n| Apples | 3 |\n| Plums | 9 |");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("| Pears | 5 |\n");
    expect(edits[0]!.new_string).toBe("");
    expectNoneMention(edits, ["Apples", "Plums", "Name"]);
  });

  it("a change inside a blockquote marks only the quoted paragraph", () => {
    const base = canon("Before.\n\n> Quote one.\n>\n> Quote two.\n>\n> Quote three.\n\nAfter.");
    const next = canon("Before.\n\n> Quote one.\n>\n> Quote two, revised.\n>\n> Quote three.\n\nAfter.");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("> Quote two.\n");
    expect(edits[0]!.new_string).toBe("> Quote two, revised.\n");
    expectNoneMention(edits, ["Quote one", "Quote three", "Before.", "After."]);
  });

  it("a list of IDENTICAL items still anchors uniquely", () => {
    // Uniqueness pressure: the minimal hunk (one item's line) matches three
    // times, so context must grow back until exactly one match remains — the
    // round-trip helper asserts that for every emitted hunk.
    const base = canon("Lead in.\n\n- same text\n- same text\n- same text\n- same text\n\nLead out.");
    const next = canon("Lead in.\n\n- same text\n- same text\n- same text\n\nLead out.");
    roundTrip(base, next);
  });

  it("identical items with a distinct one edited between them", () => {
    const base = canon("- dup\n- dup\n- unique middle\n- dup\n- dup");
    const next = canon("- dup\n- dup\n- unique middle EDITED\n- dup\n- dup");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toContain("unique middle");
  });

  it("an ordered list renumbers correctly when an item is removed", () => {
    const base = canon("1. one\n2. two\n3. three\n4. four");
    const next = canon("1. one\n2. three\n3. four");
    const edits = roundTrip(base, next);
    // The hunk must not carry the UNCHANGED head of the list…
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).not.toContain("1. one");
    // …but it necessarily carries the renumbered TAIL: `docToMarkdown` numbers
    // items from the list's `start`, so dropping item 2 really does rewrite the
    // text of every line after it. There is no smaller correct hunk, and
    // accepting the removal means accepting the renumbering — they are one
    // change. This is the documented exception to per-item hunk minimality.
    expect(edits[0]!.old_string).toBe("2. two\n\n3. three\n\n4. four");
    expect(edits[0]!.new_string).toBe("2. three\n\n3. four");
  });

  it("rewording two items of ONE ordered list still gives two one-line hunks", () => {
    // Renumbering is what defeats minimization, so an in-place reword — which
    // changes no ordinal — must stay per-item even in an ordered list.
    const base = canon("1. one\n2. two\n3. three\n4. four");
    const next = canon("1. ONE\n2. two\n3. three\n4. FOUR");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(2);
    expect(edits[0]!.old_string).toBe("1. one\n");
    expect(edits[0]!.new_string).toBe("1. ONE\n");
    expect(edits[1]!.old_string).toBe("4. four");
    expect(edits[1]!.new_string).toBe("4. FOUR");
  });

  it("a change to the CONTAINER itself (bullet → ordered) is not lost", () => {
    // Descent only happens for same-markup containers; a list that changes type
    // must still round-trip (as a whole-block replacement).
    const base = canon("Intro.\n\n- alpha\n- beta\n- gamma\n\nOutro.");
    const next = canon("Intro.\n\n1. alpha\n2. beta\n3. gamma\n\nOutro.");
    roundTrip(base, next);
  });

  it("a list change PLUS a paragraph change stay separate hunks", () => {
    const base = canon("Opening paragraph.\n\n- alpha\n- beta\n- gamma\n\nClosing paragraph.");
    const next = canon("Opening paragraph, revised.\n\n- alpha\n- beta EDITED\n- gamma\n\nClosing paragraph.");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(2);
    expectNoneMention(edits, ["Closing paragraph"]);
  });
});

/**
 * Every hunk must stand ALONE against the untouched document.
 *
 * The reviewer decides hunks one at a time and in any order: the ghost overlay
 * paints each one against the live document independently (`buildRunSegments`),
 * and Accept/Reject on a single row applies just that one. A hunk that only
 * matches once its sibling has been accepted first is therefore invisible in the
 * preview and, if decided out of order, is stamped `conflict` and dropped from
 * the pending set for good — the user is told the document changed, which is a
 * lie, and there is no way to discover the dependency.
 *
 * Per-container chaining (successive states of one list) is what introduced
 * these: each state is minimized against the document as it is AFTER its
 * predecessors, so its context can be text that only a predecessor produced.
 */
describe("computeStrEdits hunks are independently applicable", () => {
  /** Assert every hunk applies on its own to the ORIGINAL document. */
  function expectEachAppliesAlone(base: string, edits: ReturnType<typeof computeStrEdits>) {
    edits.forEach((e, i) => {
      const res = applyStrEditsStrict(base, [e]);
      expect(`hunk ${i}: ${JSON.stringify(res.conflicts)}`).toBe(`hunk ${i}: []`);
      // Exactly-once is what makes "apply it alone" well-defined in the first
      // place; a hunk matching twice would be applied at an arbitrary site.
      expect(count(base, e.old_string)).toBe(1);
    });
  }

  it("the SAME checklist line in two sections: each hunk still anchors in the baseline", () => {
    // Two separate lists share one checklist line and both are edited. Each hunk
    // must be unique in the baseline, chained or not, so either can be accepted alone.
    const base = canon(
      [
        "## Ready to Start",
        "",
        "- [ ] Task is `Walked` and estimated in points",
        "- [ ] Finish checks are written",
        "",
        "## Done Means",
        "",
        "- [ ] Task is `Walked` and estimated in points",
        "- [ ] Before-and-after photo taken",
      ].join("\n"),
    );
    const next = base.replace(/points/g, "days");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(2);
    expectEachAppliesAlone(base, edits);
    // …and independence is paid for in the cheapest currency available: ONE more
    // line of context, taken from inside the same list. Each hunk stays in its
    // own section — no heading swallowed, no merge with the other hunk, no
    // whole-document fallback.
    expect(edits[0]!.old_string).toBe(
      "* \\[ \\] Task is `Walked` and estimated in points\n\n* \\[ \\] Finish checks are written",
    );
    expect(edits[1]!.old_string).toBe(
      "* \\[ \\] Task is `Walked` and estimated in points\n\n* \\[ \\] Before-and-after photo taken",
    );
    expectNoneMention([edits[0]!], ["Ready to Start", "Done Means", "Before-and-after photo taken"]);
    expectNoneMention([edits[1]!], ["Ready to Start", "Done Means", "Finish checks"]);
  });

  it("an item reworded to match a later item does not chain off an intermediate", () => {
    // The LCS pairs the reword as a del-run plus a separate ins-run, so the
    // chain's first state was a FOUR-item list neither the agent nor the user
    // ever authored, and the second state's anchor existed only in that state.
    const base = canon("## H\n\n1. alpha 0\n2. alpha 1\n3. alpha 2\n4. alpha 0\n5. alpha 1\n\ntail.");
    const next = canon("## H\n\n1. alpha 0\n2. alpha 2\n3. alpha 2\n4. alpha 0\n5. alpha 1\n\ntail.");
    const edits = roundTrip(base, next);
    expectEachAppliesAlone(base, edits);
    // It is one reword, so it should read as one.
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("2. alpha 1\n");
    expect(edits[0]!.new_string).toBe("2. alpha 2\n");
  });

  it("two edited items with IDENTICAL text each anchor uniquely in the baseline", () => {
    // `{old: "* x\n"}` matches twice in the untouched document, so the second
    // chain member was only anchorable after the first had rewritten its twin.
    const base = canon("- x\n- x\n- y");
    const next = canon("- p\n- q\n- y");
    const edits = roundTrip(base, next);
    expectEachAppliesAlone(base, edits);
  });

  it("keeps per-item granularity when the items are distinguishable", () => {
    // The independence requirement must not collapse every list into one hunk:
    // this is the case the whole per-item review feature exists for.
    const base = canon("- alpha\n- beta\n- gamma");
    const next = canon("- ALPHA\n- beta\n- GAMMA");
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(2);
    expectEachAppliesAlone(base, edits);
    expectNoneMention(edits, ["beta"]);
  });

  it("accepting only the SECOND hunk leaves the first change untouched", () => {
    const base = canon("- alpha\n- beta\n- gamma");
    const next = canon("- ALPHA\n- beta\n- GAMMA");
    const edits = computeStrEdits(base, next);
    const res = applyStrEditsStrict(base, [edits[1]!]);
    expect(res.conflicts).toEqual([]);
    expect(res.markdown).toBe(canon("- alpha\n- beta\n- GAMMA"));
  });

  it("every hunk of a multi-edit list stands alone (fuzz over repeating items)", () => {
    // Repeating item text is what makes anchoring hard, so generate it on
    // purpose and assert the property over the whole space.
    const words = ["alpha", "beta", "gamma"];
    let checked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
      const ordered = r() < 0.5;
      const items = Array.from({ length: 3 + Math.floor(r() * 4) }, () => `${pick(words)} ${Math.floor(r() * 2)}`);
      const render = (its: string[]) => its.map((t, i) => (ordered ? `${i + 1}. ${t}` : `- ${t}`)).join("\n");
      const nextItems = [...items];
      for (let e = 0; e < 2 + Math.floor(r() * 2); e++) {
        if (nextItems.length === 0) break;
        const at = Math.floor(r() * nextItems.length);
        const op = r();
        if (op < 0.55) nextItems[at] = `${pick(words)} ${Math.floor(r() * 2)}`;
        else if (op < 0.8) nextItems.splice(at, 1);
        else nextItems.splice(at, 0, `${pick(words)} ${Math.floor(r() * 2)}`);
      }
      if (nextItems.length === 0) continue;
      const base = canon(render(items));
      const next = canon(render(nextItems));
      if (base === next) continue;
      checked++;
      const edits = computeStrEdits(base, next);
      expect(applyStrEdits(base, edits)).toBe(next);
      edits.forEach((e, i) => {
        const res = applyStrEditsStrict(base, [e]);
        expect(`seed ${seed} hunk ${i}: ${JSON.stringify(res.conflicts)}`).toBe(`seed ${seed} hunk ${i}: []`);
      });
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe("computeStrEdits invariant under nested mutations (fuzz)", () => {
  function buildDoc(rand: () => number): string {
    const parts: string[] = ["# Fuzz document"];
    const n = 2 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      const kind = Math.floor(rand() * 5);
      const k = 2 + Math.floor(rand() * 4);
      if (kind === 0) parts.push(`Paragraph ${i} text.`);
      else if (kind === 1) parts.push(Array.from({ length: k }, (_, j) => `- item ${i}.${j}`).join("\n"));
      else if (kind === 2) parts.push(Array.from({ length: k }, (_, j) => `${j + 1}. step ${i}.${j}`).join("\n"));
      else if (kind === 3)
        parts.push(
          [`| Col A${i} | Col B${i} |`, "| --- | --- |", ...Array.from({ length: k }, (_, j) => `| r${i}.${j} | v${i}.${j} |`)].join("\n"),
        );
      else parts.push(Array.from({ length: k }, (_, j) => `> quote ${i}.${j}`).join("\n>\n"));
    }
    return canon(parts.join("\n\n"));
  }

  /** Mutate a canonical document by editing/removing/duplicating whole LINES. */
  function mutate(md: string, rand: () => number): string {
    const lines = md.split("\n");
    const rounds = 1 + Math.floor(rand() * 3);
    for (let r = 0; r < rounds; r++) {
      const i = Math.floor(rand() * lines.length);
      const line = lines[i]!;
      if (line.trim() === "" || line.startsWith("| ---")) continue;
      const op = Math.floor(rand() * 3);
      if (op === 0) lines[i] = line + " CHANGED";
      else if (op === 1 && lines.length > 4) lines.splice(i, 1);
      else lines.splice(i, 0, line.replace(/\S+$/, "extra"));
    }
    return canon(lines.join("\n"));
  }

  it("round-trips and stays unique across 200 generated edits", () => {
    const rand = rng(20260809);
    let checked = 0;
    for (let t = 0; t < 200; t++) {
      const base = buildDoc(rand);
      const next = mutate(base, rand);
      if (base === next) continue;
      checked++;
      // roundTrip asserts BOTH halves of the contract: applyStrEdits(base,
      // edits) === next, and every old_string is unique when its hunk runs.
      roundTrip(base, next);
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("a wholesale list rewrite degrades to one hunk instead of hundreds", () => {
    const base = canon(Array.from({ length: 60 }, (_, i) => `- item ${i}`).join("\n"));
    const next = canon(Array.from({ length: 60 }, (_, i) => `- rewritten ${i}`).join("\n"));
    const edits = roundTrip(base, next);
    expect(edits).toHaveLength(1);
  });

  it("many small edits in one list stay individually reviewable up to the cap", () => {
    const base = canon(Array.from({ length: 30 }, (_, i) => `- item ${i}`).join("\n"));
    // Change every OTHER item, so the changed items are never adjacent.
    const next = canon(
      Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? `- item ${i} tweaked` : `- item ${i}`)).join("\n"),
    );
    const edits = roundTrip(base, next);
    expect(edits.length).toBeGreaterThan(1);
    for (const e of edits) expect(e.old_string.length).toBeLessThan(base.length / 4);
  });
});

describe("applyStrEditsStrict", () => {
  it("applies matching edits and reports their indices", () => {
    const res = applyStrEditsStrict("one two three", [
      { old_string: "one", new_string: "1" },
      { old_string: "three", new_string: "3" },
    ]);
    expect(res.markdown).toBe("1 two 3");
    expect(res.applied).toEqual([0, 1]);
    expect(res.conflicts).toEqual([]);
  });

  it("reports unmatched edits as conflicts without aborting the rest", () => {
    const res = applyStrEditsStrict("one two three", [
      { old_string: "one", new_string: "1" },
      { old_string: "MISSING", new_string: "x" },
      { old_string: "three", new_string: "3" },
    ]);
    expect(res.markdown).toBe("1 two 3");
    expect(res.applied).toEqual([0, 2]);
    expect(res.conflicts).toEqual([1]);
  });

  it("treats an empty old_string as an append (always applies)", () => {
    const res = applyStrEditsStrict("body", [{ old_string: "", new_string: "\n\ntail" }]);
    expect(res.markdown).toBe("body\n\ntail");
    expect(res.applied).toEqual([0]);
    expect(res.conflicts).toEqual([]);
  });

  it("matches applyStrEdits output exactly (same matcher, same order)", () => {
    const edits = [
      { old_string: "brown", new_string: "red" },
      { old_string: "nope", new_string: "!" },
      { old_string: "", new_string: " end" },
    ];
    const text = "the quick brown fox";
    expect(applyStrEditsStrict(text, edits).markdown).toBe(applyStrEdits(text, edits));
  });

  it("reports an AMBIGUOUS old_string as a conflict instead of taking the first hit", () => {
    // The review path applies arbitrary SUBSETS of a run out of the order they
    // were generated in, so an old_string that was unique when its hunk was
    // computed can match twice. Rewriting the first of the two would silently
    // change the wrong paragraph and report success.
    const res = applyStrEditsStrict("Alpha\n\nMid\n\nAlpha", [{ old_string: "Alpha", new_string: "Gamma" }]);
    expect(res.markdown).toBe("Alpha\n\nMid\n\nAlpha");
    expect(res.applied).toEqual([]);
    expect(res.conflicts).toEqual([0]);
  });

  it("accepting only the SECOND of two hunks lands it, and only it", () => {
    // Two identical paragraphs, both rewritten. The second hunk's minimal form
    // ("Alpha") is unique only after the first has rewritten its twin, so
    // `computeStrEdits` grows it until it pins in the UNTOUCHED document too —
    // otherwise this exact call, which is what the server makes when a reviewer
    // accepts one hunk, would be refused as a phantom conflict.
    const base = "Alpha\n\nMid\n\nAlpha";
    const edits = computeStrEdits(base, "Beta\n\nMid\n\nGamma");
    expect(edits).toHaveLength(2);
    // In sequence they both land…
    expect(applyStrEditsStrict(base, edits)).toMatchObject({ conflicts: [] });
    // …and so does the second on its own, against the baseline.
    const partial = applyStrEditsStrict(base, [edits[1]!]);
    expect(partial.conflicts).toEqual([]);
    expect(partial.markdown).toBe("Alpha\n\nMid\n\nGamma");
    // The first is untouched by that: order of decision does not matter.
    expect(applyStrEditsStrict(base, [edits[0]!])).toMatchObject({
      conflicts: [],
      markdown: "Beta\n\nMid\n\nAlpha",
    });
  });

  it("an inverse (revert) list whose old_strings collide conflicts rather than transposing", () => {
    // Two hunks producing the SAME new_string make the reversed inverse list
    // ambiguous; first-match would swap the two originals and report success.
    const base = "X\n\nMid\n\nZ";
    const edits = computeStrEdits(base, "Y\n\nMid\n\nY");
    const applied = applyStrEditsStrict(base, edits);
    expect(applied.markdown).toBe("Y\n\nMid\n\nY");
    const inverse = [...edits].reverse().map((e) => ({ old_string: e.new_string, new_string: e.old_string }));
    const res = applyStrEditsStrict(applied.markdown, inverse);
    expect(res.conflicts).toHaveLength(2);
    expect(res.markdown).toBe(applied.markdown);
  });

  it("edits are sequential: a later edit can match text a prior edit produced", () => {
    const res = applyStrEditsStrict("aaa", [
      { old_string: "aaa", new_string: "bbb" },
      { old_string: "bbb", new_string: "ccc" },
    ]);
    expect(res.markdown).toBe("ccc");
    expect(res.applied).toEqual([0, 1]);
    expect(res.conflicts).toEqual([]);
  });
});
