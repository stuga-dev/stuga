import { describe, expect, it } from "vitest";
import {
  aliasFromMentionHref,
  commentMentionCandidates,
  commentSegments,
  markdownMentionAliases,
  mentionHref,
} from "./mentions";

describe("commentMentionCandidates", () => {
  it("finds usernames after whitespace or punctuation, not inside an email", () => {
    expect(commentMentionCandidates("@Ada can you and (@bob) look? mail ada@example.com")).toEqual(["ada", "bob"]);
  });

  it("offers a username both with and without a sentence's closing dot", () => {
    expect(commentMentionCandidates("Thanks @ada.l.")).toEqual(["ada.l.", "ada.l"]);
  });

  it("ignores a lone @ and one-character names", () => {
    expect(commentMentionCandidates("@ and @a")).toEqual([]);
  });
});

describe("commentSegments", () => {
  const ada = { alias: "u_ada", username: "ada" };

  it("marks only resolved usernames and keeps the rest as text", () => {
    expect(commentSegments("hi @ada and @nobody.", [ada])).toEqual([
      { text: "hi " },
      { text: "@ada", mention: ada },
      { text: " and @nobody." },
    ]);
  });

  it("leaves a closing dot outside the mention", () => {
    expect(commentSegments("Thanks @ada.", [ada])).toEqual([{ text: "Thanks " }, { text: "@ada", mention: ada }, { text: "." }]);
  });

  it("matches case-insensitively and returns the text as typed", () => {
    expect(commentSegments("@ADA", [ada])).toEqual([{ text: "@ADA", mention: ada }]);
  });
});

describe("document mention links", () => {
  it("round-trips any alias through the link target", () => {
    for (const alias of ["u_abc", "auth0|1234", "sub with space)"]) {
      expect(aliasFromMentionHref(mentionHref(alias))).toBe(alias);
    }
    expect(aliasFromMentionHref("https://example.com")).toBeNull();
    expect(aliasFromMentionHref("mention:%E0%A4%A")).toBeNull();
  });

  it("lists the people a document's Markdown mentions, once each", () => {
    const md = `Hi [@ada](${mentionHref("u_ada")}) and [@bob](${mentionHref("u_bob")}), again [@ada](${mentionHref("u_ada")}). [a link](https://x.test)`;
    expect(markdownMentionAliases(md)).toEqual(["u_ada", "u_bob"]);
  });
});
