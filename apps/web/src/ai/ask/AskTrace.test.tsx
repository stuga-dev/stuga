import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AskTrace } from "./AskTrace";

const steps = [
  { kind: "search" as const, query: "project plan", hits: 2 },
  { kind: "read" as const, doc_id: "d_1", title: "Plan", chars: 4850 },
  { kind: "query" as const, database_id: "d_2", title: "Tasks", sql: "SELECT * FROM tasks", rows: 3 },
];

describe("AskTrace", () => {
  it("starts collapsed while the answer is written and once it is complete", () => {
    for (const isWorking of [true, false]) {
      const html = renderToStaticMarkup(<AskTrace steps={steps} isWorking={isWorking} />);
      expect(html).toContain('<details class="ask-trace">');
      expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    }
  });

  it("names the research in plain language, while working and once complete", () => {
    expect(renderToStaticMarkup(<AskTrace steps={steps} isWorking />)).toContain("Looking through your documents…");
    const html = renderToStaticMarkup(<AskTrace steps={steps} />);
    expect(html).toContain("How this answer was found");
    expect(html).toContain("Searched for “project plan” — 2 results");
    expect(html).toContain("Read “Plan”");
    expect(html).not.toContain("4,850 characters");
    expect(html).toContain("Checked “Tasks” — 3 rows");
  });

  it("shows the SQL a database step ran as code under that step, and on no other step", () => {
    const html = renderToStaticMarkup(<AskTrace steps={steps} />);
    expect(html).toMatch(/Checked “Tasks” — 3 rows<\/span><code[^>]*>SELECT \* FROM tasks<\/code><\/li>/);
    expect(html.match(/<code/g)).toHaveLength(1);
  });
});
