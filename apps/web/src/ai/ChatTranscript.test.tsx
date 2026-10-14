// @vitest-environment jsdom
/** A turn that asked the person something in comments links to the first thread it opened, where there are comments. */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { mountInto } from "../test/form-input";
import { ChatTranscript, type ChatTurn } from "./ChatTranscript";

const turns: ChatTurn[] = [
  { role: "user", text: "Tidy the renovation checklist." },
  { role: "assistant", text: "Tidied it; one line depends on the bathtub.", asked: [12, 13] },
];

async function render(onOpenComment?: (num: number) => void) {
  const { host, root } = mountInto();
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ChatTranscript turns={turns} streaming={false} empty={null} onOpenComment={onOpenComment} />
      </MemoryRouter>,
    );
  });
  return host;
}

const askedRow = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => b.textContent === "Asked in 2 comments");

describe("ChatTranscript: questions asked in comments", () => {
  it("opens the first thread the turn asked in", async () => {
    const open = vi.fn();
    const host = await render(open);
    await act(async () => askedRow(host)!.click());
    expect(open).toHaveBeenCalledWith(12);
  });

  it("shows no link where there are no comments to open", async () => {
    const host = await render();
    expect(askedRow(host)).toBeUndefined();
  });
});
