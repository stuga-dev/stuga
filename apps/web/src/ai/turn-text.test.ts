import { afterEach, describe, expect, it } from "vitest";
import { loadUiLanguage } from "../i18n/i18n";
import {
  askActivityText,
  askNoticeText,
  coauthorActivityText,
  coauthorErrorText,
  coauthorNoticesText,
  crossDocErrorText,
  tableActivityText,
  tableNoticeText,
} from "./turn-text";

afterEach(async () => {
  await loadUiLanguage("en");
});

describe("Ask", () => {
  it("words what the agent is doing", () => {
    expect(askActivityText({ kind: "searching", query: "launch date" })).toBe("Searching “launch date”…");
    expect(askActivityText({ kind: "reading", title: "Roadmap" })).toBe("Reading “Roadmap”…");
    expect(askActivityText({ kind: "reading", title: "" })).toBe("Reading “a document”…");
    expect(askActivityText({ kind: "listing" })).toBe("Looking through your documents…");
    expect(askActivityText({ kind: "querying", title: "Projects" })).toBe("Querying a database…");
    expect(askActivityText({ kind: "thinking" })).toBe("Thinking…");
  });

  it("words why an answer is incomplete, the provider's trouble when it is known", () => {
    expect(askNoticeText({ code: "aborted" })).toBe("Stopped.");
    expect(askNoticeText({ code: "error", failure: "quota" })).toBe(
      "The AI provider says the account is out of credit. An administrator can check Settings → This node → AI providers.",
    );
    expect(askNoticeText({ code: "error", failure: "rejected" })).toBe("Something failed part-way through; this answer may be incomplete.");
    expect(askNoticeText({ code: "error", failure: null })).toBe("Something failed part-way through; this answer may be incomplete.");
  });
});

describe("the table assistant", () => {
  it("words its activity and its notices", () => {
    expect(tableActivityText({ kind: "reading" })).toBe("Reading the schema…");
    expect(tableActivityText({ kind: "searching", query: "pricing" })).toBe("Searching for “pricing”…");
    expect(tableNoticeText({ code: "max_rounds", rounds: 12 })).toBe("Stopped after 12 rounds of work. Ask me to continue if there’s more to do.");
    expect(tableNoticeText({ code: "ended_early", kept: "applied", failure: "auth" })).toBe(
      "The turn ended early, but the changes above were applied. The AI provider did not accept this node’s key. An administrator can check Settings → This node → AI providers.",
    );
    expect(tableNoticeText({ code: "ended_early", kept: "staged", failure: null })).toBe(
      "The answer ended early, but the changes above are waiting for review.",
    );
  });
});

describe("the document co-author", () => {
  it("words its activity", () => {
    expect(coauthorActivityText({ kind: "searching", query: "" })).toBe("Searching the knowledge base…");
    expect(coauthorActivityText({ kind: "applying" })).toBe("Applying changes…");
  });

  it("runs its notices on as one passage, and has none to show for an empty list", () => {
    expect(coauthorNoticesText([])).toBeNull();
    expect(coauthorNoticesText([{ code: "stopped", kept: null }, { code: "images_truncated", count: 8 }])).toBe(
      "Stopped. Only the first 8 images were downloaded; the rest kept their original links.",
    );
  });

  it("joins sentences without a space where the language does", async () => {
    await loadUiLanguage("ja");
    expect(coauthorNoticesText([{ code: "ended_early", failure: "unavailable" }])).toBe(
      "途中で終了しました。AIプロバイダーは現在利用できません。しばらくしてから再試行してください。",
    );
  });

  it("words its errors, an unexpected one in its own text", () => {
    expect(coauthorErrorText({ code: "stale" })).toBe("The document changed while the AI was writing, so its changes no longer applied.");
    expect(coauthorErrorText({ code: "ai_disabled" })).toBe("AI chat is disabled on this node.");
    expect(coauthorErrorText({ code: "failed", failure: null })).toBe("The AI turn failed.");
    expect(coauthorErrorText({ code: "failed", failure: null, detail: "endpoint unreachable" })).toBe("endpoint unreachable");
    expect(coauthorErrorText({ code: "propose_failed" })).toBe("The changes couldn’t be proposed.");
    expect(coauthorErrorText({ code: "review_backlog", count: 50 })).toBe(
      "This document already has 50 proposals waiting for review. Decide on some before asking for more changes.",
    );
  });

  it("words an image it left linked, with the node's reason in the reader's language", () => {
    expect(coauthorNoticesText([{ code: "image_not_downloaded", url: "https://e.test/x.png", reason: "image is empty" }])).toBe(
      "Couldn’t download https://e.test/x.png (Image is empty), so its link was left as-is.",
    );
  });

  it("words why another document's changes were not proposed", () => {
    expect(crossDocErrorText({ code: "no_access" }, "Plan")).toBe("Couldn’t propose changes in “Plan”: this conversation can’t edit it.");
    expect(crossDocErrorText({ code: "unreachable" }, "Plan")).toBe("Couldn’t reach “Plan”, so no changes were proposed there.");
    expect(crossDocErrorText(undefined, "Plan")).toBe("Couldn’t propose changes in “Plan”.");
  });
});
