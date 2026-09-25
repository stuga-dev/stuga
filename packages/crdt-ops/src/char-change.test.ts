/**
 * Character change counts for version history: a contiguous edit reports the
 * characters it touched, untouched lines and words are free, a formatting
 * change counts its marks, a same-length rewrite is not "nothing changed",
 * moved blocks are not churn, and the counts stay
 * non-negative, bounded by each side, consistent with the length delta, never
 * below the real difference nor above the plain trim, and the same either way
 * round.
 */
import { describe, expect, it } from "vitest";
import { charChangeCounts } from "./diff/char-counts.js";

describe("charChangeCounts", () => {
  it("reports nothing for identical text", () => {
    expect(charChangeCounts("# Title\n\nbody", "# Title\n\nbody")).toEqual({ added: 0, removed: 0 });
  });

  it("counts a first version as pure insertion", () => {
    expect(charChangeCounts("", "hello")).toEqual({ added: 5, removed: 0 });
  });

  it("counts a wipe as pure deletion", () => {
    expect(charChangeCounts("hello", "")).toEqual({ added: 0, removed: 5 });
  });

  it("counts only the characters a contiguous edit touched", () => {
    // One word swapped in the middle of a long line: the prefix/suffix trim
    // alone is the exact answer, so nothing else may be counted.
    const base = "The quick brown fox jumps over the lazy dog.";
    const next = "The quick red fox jumps over the lazy dog.";
    expect(charChangeCounts(base, next)).toEqual({ added: 3, removed: 5 });
  });

  it("counts an appended paragraph, not the paragraphs above it", () => {
    const base = "# Doc\n\nOne.\n\nTwo.";
    const next = "# Doc\n\nOne.\n\nTwo.\n\nThree.";
    expect(charChangeCounts(base, next)).toEqual({ added: "\n\nThree.".length, removed: 0 });
  });

  it("sees a same-length rewrite that a net length delta would miss", () => {
    const base = "alpha\n\nbravo\n\ncharlie";
    const next = "alpha\n\nDELTA\n\ncharlie";
    const { added, removed } = charChangeCounts(base, next);
    expect(added).toBe(5);
    expect(removed).toBe(5);
    // The whole point: the net delta is zero and would have read "no change".
    expect(next.length - base.length).toBe(0);
  });

  it("does not charge untouched lines when a line is deleted from the middle", () => {
    const base = "one\ntwo\nthree\nfour\nfive";
    const next = "one\ntwo\nfour\nfive";
    // "three\n" leaves; "one/two/four/five" are matched lines and stay free.
    expect(charChangeCounts(base, next)).toEqual({ added: 0, removed: 6 });
  });

  it("does not charge untouched lines when a line is inserted in the middle", () => {
    const base = "one\ntwo\nfour\nfive";
    const next = "one\ntwo\nthree\nfour\nfive";
    expect(charChangeCounts(base, next)).toEqual({ added: 6, removed: 0 });
  });

  it("does not charge an untouched line the trim cut into", () => {
    // The trim ends inside "Hello…" ("." is shared with "New."): that line must
    // still match its twin whole. "A" → "B" plus "\n\nNew." is all that changed.
    const base = "# A\n\nHello world, this line is untouched.";
    const next = "# B\n\nHello world, this line is untouched.\n\nNew.";
    expect(charChangeCounts(base, next)).toEqual({ added: 7, removed: 1 });
  });

  it("charges only the edited heading and the new paragraphs, not the paragraph between", () => {
    const base = "# Team plan\n\nFirst paragraph written by Liv at creation.";
    const next =
      "\n# Liv edit two.Team plan\n\nFirst paragraph written by Liv at creation.\n\nAda edit one.\n\nBob edit three.";
    // The heading's two insertions share one run, whose words keep "# " too.
    // The first paragraph is free.
    expect(charChangeCounts(base, next)).toEqual({
      added: "\n".length + "Liv edit two.".length + "\n\nAda edit one.\n\nBob edit three.".length,
      removed: 0,
    });
  });

  it("charges an edited paragraph only its edit when a new one follows it", () => {
    // Only the blank lines match whole: the one that keeps the edited paragraph
    // next to its twin must win the tie, whichever text comes first.
    expect(charChangeCounts("Title\n\nBody text.", "Title v2\n\nBody text, more.\n\nNew.")).toEqual({
      added: 15,
      removed: 0,
    });
    const base = "# Team plan\n\nFirst paragraph written by Liv at creation.";
    const next = "# Team plan v2\n\nFirst paragraph written by Liv at creation, edited.\n\nAda edit one.";
    expect(charChangeCounts(base, next)).toEqual({ added: 26, removed: 0 });
    expect(charChangeCounts(next, base)).toEqual({ added: 0, removed: 26 });
  });

  it("does not charge a line that a join leaves whole", () => {
    // "Alpha beta\n" and the "\n" after "Keep me." go; "Keep me." stays.
    const split = "Intro. Alpha beta\nKeep me.\n Outro.";
    const joined = "Intro. Keep me. Outro.";
    expect(charChangeCounts(split, joined)).toEqual({ added: 0, removed: 12 });
    expect(charChangeCounts(joined, split)).toEqual({ added: 12, removed: 0 });
  });

  it("counts a formatting change by its marks, not the words inside", () => {
    expect(charChangeCounts("alpha beta", "**alpha** beta")).toEqual({ added: 4, removed: 0 });
    expect(charChangeCounts("**alpha** beta", "alpha beta")).toEqual({ added: 0, removed: 4 });
    expect(charChangeCounts("**alpha** beta", "_alpha_ beta")).toEqual({ added: 2, removed: 4 });
    const para = "The quarterly plan covers hiring, the new office, and a budget review before the end of year.";
    expect(charChangeCounts(`# Plan\n\n${para}\n\nNext.`, `# Plan\n\n**${para}**\n\nNext.`)).toEqual({
      added: 4,
      removed: 0,
    });
    expect(charChangeCounts("我们的会议计划", "我们的**会议**计划")).toEqual({ added: 4, removed: 0 });
  });

  it("counts two edits in one line as the two edits, not the stretch between", () => {
    // "quick" → "slow" is a whole word; "today" → "tonight" keeps "to".
    const base = "# T\n\nThe quick brown fox jumps over the lazy dog near the old river bank today.\n";
    const next = "# T\n\nThe slow brown fox jumps over the lazy dog near the old river bank tonight.\n";
    expect(charChangeCounts(base, next)).toEqual({ added: 4 + 5, removed: 5 + 3 });
    expect(charChangeCounts(next, base)).toEqual({ added: 5 + 3, removed: 4 + 5 });
  });

  it("counts bold across a whole long document by its marks", () => {
    const paras = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} of the plan, with some words to diff.`.repeat(8));
    const base = paras.join("\n\n");
    const next = paras.map((p) => `**${p}**`).join("\n\n");
    expect(charChangeCounts(base, next)).toEqual({ added: 300 * 4, removed: 0 });
  });

  it("treats a \\r as text, so CRLF lines still match their twins", () => {
    // "A" → "B" plus "\r\n\r\nNew." after the last line.
    const base = "# A\r\n\r\nHello world.";
    expect(charChangeCounts(base, "# B\r\n\r\nHello world.\r\n\r\nNew.")).toEqual({ added: 9, removed: 1 });
  });

  it("counts an edit inside the only line", () => {
    expect(charChangeCounts("Hello world", "Hello there")).toEqual({ added: 5, removed: 5 });
    expect(charChangeCounts("The plan is final.", "The plan is draft.")).toEqual({ added: 5, removed: 5 });
  });

  it("counts an edit in the first or last line that shares its punctuation with the next", () => {
    const base = "Alpha one.\nBeta two.\nGamma three.";
    expect(charChangeCounts(base, "Alpha ONE.\nBeta two.\nGamma three.")).toEqual({ added: 3, removed: 3 });
    expect(charChangeCounts(base, "Alpha one.\nBeta two.\nGamma THREE.")).toEqual({ added: 5, removed: 5 });
    // "." → "!" in the first line, "\nThree." after the last.
    expect(charChangeCounts("One.\nTwo.", "One!\nTwo.\nThree.")).toEqual({ added: 8, removed: 1 });
  });

  it("matches empty lines without charging the lines around them", () => {
    expect(charChangeCounts("Title\n\n\n\nBody", "Title!\n\n\n\nBody.")).toEqual({ added: 2, removed: 0 });
  });

  it("reports nothing for identical multi-line text", () => {
    for (const text of ["\n", "\n\n", "a\n\nb\n", "# T\n\n- one\n- two\n"]) {
      expect(charChangeCounts(text, text)).toEqual({ added: 0, removed: 0 });
    }
  });

  it("counts a pure insert at the start or the end", () => {
    const base = "Body.\n\nMore.";
    expect(charChangeCounts(base, `# Title\n\n${base}`)).toEqual({ added: 9, removed: 0 });
    expect(charChangeCounts(base, `${base}\n\nEnd.`)).toEqual({ added: 6, removed: 0 });
    expect(charChangeCounts(`${base}\n\nEnd.`, base)).toEqual({ added: 0, removed: 6 });
  });

  it("counts a line split in two, and joined back, as the break alone", () => {
    const whole = "Intro.\n\nFirst half second half\n\nOutro.";
    const split = "Intro.\n\nFirst half\n\nsecond half\n\nOutro.";
    expect(charChangeCounts(whole, split)).toEqual({ added: 2, removed: 1 });
    expect(charChangeCounts(split, whole)).toEqual({ added: 1, removed: 2 });
    expect(charChangeCounts("Hello world", "Hello\nworld")).toEqual({ added: 1, removed: 1 });
  });

  it("does not report a moved newline as no change", () => {
    expect(charChangeCounts("xyz12345\n", "\nxyz12345")).toEqual({ added: 1, removed: 1 });
  });

  it("stays between the real difference and the plain trim, either way round", () => {
    // Against the exact character LCS: the counts are an upper bound on the
    // smallest edit, never below it.
    const lcs = (x: string, y: string): number => {
      let prev: number[] = Array.from({ length: y.length + 1 }, () => 0);
      for (let i = 1; i <= x.length; i++) {
        const cur = [0];
        for (let j = 1; j <= y.length; j++) {
          cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
        }
        prev = cur;
      }
      return prev[y.length]!;
    };
    const plainRemoved = (x: string, y: string): number => {
      const max = Math.min(x.length, y.length);
      let pre = 0;
      while (pre < max && x[pre] === y[pre]) pre++;
      let suf = 0;
      while (suf < max - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
      return x.length - pre - suf;
    };
    let seed = 1;
    const rand = (k: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return Math.floor((seed / 2 ** 32) * k);
    };
    const text = (len: number): string => Array.from({ length: len }, () => "ab\nc *"[rand(6)]).join("");
    for (let t = 0; t < 2000; t++) {
      const base = text(rand(14));
      const next =
        rand(2) === 0
          ? text(rand(14))
          : base.slice(0, rand(base.length + 1)) + text(rand(4)) + base.slice(rand(base.length + 1));
      const { added, removed } = charChangeCounts(base, next);
      const common = lcs(base, next);
      const pair = JSON.stringify([base, next]);
      expect(removed, pair).toBeGreaterThanOrEqual(base.length - common);
      expect(removed, pair).toBeLessThanOrEqual(plainRemoved(base, next));
      expect(added - removed, pair).toBe(next.length - base.length);
      expect(charChangeCounts(next, base), pair).toEqual({ added: removed, removed: added });
    }
  });

  it("charges a reordered pair once, not the whole document", () => {
    const base = "intro\n\naaa\n\nbbb\n\noutro";
    const next = "intro\n\nbbb\n\naaa\n\noutro";
    const { added, removed } = charChangeCounts(base, next);
    // One of the two moved blocks is re-matched by the line LCS, so this costs
    // one block — never the four lines a naive middle-span count would charge.
    expect(added).toBeLessThanOrEqual(5);
    expect(removed).toBeLessThanOrEqual(5);
    expect(added).toBeGreaterThan(0);
  });

  it("stays bounded (and still sane) past the work cap", () => {
    // 5000x5000 = 25M cells, past CHAR_CHANGE_MAX_CELLS — the coarse branch. It
    // must still return finite, non-negative counts within each side's length.
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const next = Array.from({ length: 5000 }, (_, i) => `LINE ${i}`).join("\n");
    const { added, removed } = charChangeCounts(base, next);
    expect(added).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
    expect(added).toBeLessThanOrEqual(next.length);
    expect(removed).toBeLessThanOrEqual(base.length);
    expect(added - removed).toBe(next.length - base.length);
    // The plain trim: everything but the shared " 4999".
    expect({ added, removed }).toEqual({ added: next.length - 5, removed: base.length - 5 });
  });

  it("still measures a LOPSIDED document accurately, and quickly", () => {
    // Deleting a chunk from a long document: 6000 × 40 lines is well under the cell cap.
    const body = Array.from({ length: 6000 }, (_, i) => `paragraph ${i}`);
    const base = body.join("\n");
    const next = [...body.slice(0, 20), ...body.slice(40)].join("\n");
    const started = Date.now();
    const { added, removed } = charChangeCounts(base, next);
    expect(added).toBe(0); // nothing was written
    // Exactly the 20 removed lines and their newlines — not the whole document.
    expect(removed).toBe(base.length - next.length);
    expect(removed).toBeLessThan(base.length / 10);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps the invariants on every pair it is given", () => {
    const samples: Array<[string, string]> = [
      ["", ""],
      ["a", "b"],
      ["\n\n\n", "\n\n"],
      ["# H\n\np1\n\np2\n", "# H\n\np1 edited\n\np2\n\np3\n"],
      ["| a | b |\n| - | - |\n| 1 | 2 |", "| a | b |\n| - | - |\n| 1 | 3 |\n| 4 | 5 |"],
      ["repeat\nrepeat\nrepeat", "repeat\nrepeat"],
      ["prefix middle suffix", "prefix suffix"],
    ];
    for (const [base, next] of samples) {
      const { added, removed } = charChangeCounts(base, next);
      expect(added, `added >= 0 for ${JSON.stringify([base, next])}`).toBeGreaterThanOrEqual(0);
      expect(removed, `removed >= 0 for ${JSON.stringify([base, next])}`).toBeGreaterThanOrEqual(0);
      expect(added).toBeLessThanOrEqual(next.length);
      expect(removed).toBeLessThanOrEqual(base.length);
      // A character is either kept, added, or removed — so the counts have to
      // reconcile with the plain length delta.
      expect(added - removed).toBe(next.length - base.length);
    }
  });
});
