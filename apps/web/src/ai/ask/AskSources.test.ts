import { describe, expect, it } from "vitest";
import { sourceCards } from "./AskSources";

const cite = (n: number, doc_id: string, title: string, heading_path: string | null, content: string) => ({
  n,
  doc_id,
  title,
  heading_path,
  content,
});

describe("sourceCards", () => {
  it("gives a document cited twice one card that carries both numbers", () => {
    const cards = sourceCards(
      [
        cite(1, "d1", "Customer feedback", "Customer feedback", "The croissants are wonderful."),
        cite(2, "d1", "Customer feedback", "Customer feedback", "The croissants are wonderful."),
        cite(3, "d2", "Flour supplier", null, "Hansen Mill delivers on Tuesdays."),
      ],
      new Map([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    );
    expect(cards.map((c) => [c.c.doc_id, c.numbers])).toEqual([
      ["d1", [1, 2]],
      ["d2", [3]],
    ]);
  });

  it("leaves out a section that only repeats the title, and keeps one that says more", () => {
    const cards = sourceCards(
      [cite(1, "d1", "Plan", "Plan", "Body text here."), cite(2, "d2", "Plan B", "Plan B > Costs", "Hosting is monthly.")],
      new Map([
        [1, 1],
        [2, 2],
      ]),
    );
    expect(cards.map((c) => c.section)).toEqual(["", "Costs"]);
  });

  it("shows only what the answer kept, in the answer's numbering", () => {
    const cards = sourceCards(
      [cite(4, "d1", "A", null, "a"), cite(7, "d2", "B", null, "b")],
      new Map([[7, 1]]),
    );
    expect(cards.map((c) => [c.c.doc_id, c.numbers])).toEqual([["d2", [1]]]);
  });
});
