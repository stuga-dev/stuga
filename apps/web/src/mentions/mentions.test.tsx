// @vitest-environment jsdom
/** The comment box's people list inside a document, and how a mention reads once posted. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, useState } from "react";
import type { UserInfo } from "../api";
import { mountInto, typeInto } from "../test/form-input";
import { toasts } from "../test/toast";

const users = vi.hoisted(() => ({ resolve: vi.fn(), search: vi.fn(), searchForMention: vi.fn() }));

vi.mock("../api", () => ({ Users: users }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

const { MentionTextArea } = await import("./MentionTextArea");
const { MentionScopeProvider } = await import("./mention-scope");
const { CommentText } = await import("./CommentText");

const omar: UserInfo = { alias: "u_omar", username: "omar", display_name: "Omar Haddad", email: null, can_open: true };
const lin: UserInfo = { alias: "u_lin", username: "lin", display_name: "Lin Wu", email: null, can_open: false };

const share = vi.fn();
let value = "";

function Box({ initial, scoped = true }: { initial: string; scoped?: boolean }) {
  const [text, setText] = useState(initial);
  value = text;
  const box = (
    <MentionTextArea
      label="Comment"
      value={text}
      onChange={(next) => {
        value = next;
        setText(next);
      }}
    />
  );
  return scoped ? <MentionScopeProvider value={{ docId: "doc1", share }}>{box}</MentionScopeProvider> : box;
}

async function mount(initial = "", scoped = true) {
  const { host, root } = mountInto();
  await act(async () => root.render(<Box initial={initial} scoped={scoped} />));
  const area = host.querySelector("textarea")!;
  await act(async () => area.focus());
  return { host, area };
}

/** Type `text`, caret at its end, and let the debounced search answer. */
async function typeAt(area: HTMLTextAreaElement, text: string, caret = text.length) {
  await typeInto(area, text);
  await act(async () => {
    area.setSelectionRange(caret, caret);
    // React reads a moved caret on a key or pointer event, not on the native `select`.
    area.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
  await act(async () => void vi.advanceTimersByTime(200));
  await act(async () => {});
}

const options = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("[role='option']")];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  toasts.shown = [];
  users.resolve.mockResolvedValue({ users: [] });
  users.searchForMention.mockResolvedValue({ users: [omar, lin], can_share: true });
  users.search.mockResolvedValue({ users: [] });
  return () => vi.useRealTimers();
});

describe("the people list in a document", () => {
  it("lists people on a bare @, asking about this document", async () => {
    const { host, area } = await mount();
    await typeAt(area, "@");

    expect(users.searchForMention).toHaveBeenCalledWith("", "doc1");
    expect(options(host).map((o) => o.querySelector(".mention-item__name")!.textContent)).toEqual(["Omar Haddad", "Lin Wu"]);
    expect(host.textContent).not.toContain("Type a name or username");
  });

  it("marks someone who cannot open the document", async () => {
    const { host, area } = await mount();
    await typeAt(area, "@");

    const [first, second] = options(host);
    expect(first!.textContent).not.toContain("Can’t open this document");
    expect(second!.textContent).toContain("Can’t open this document");
  });

  it("still asks for two letters outside a document", async () => {
    const { host, area } = await mount("", false);
    await typeAt(area, "@");

    expect(users.search).not.toHaveBeenCalled();
    expect(users.searchForMention).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Type a name or username");
  });

  it("says so when no one else can open the document", async () => {
    users.searchForMention.mockResolvedValue({ users: [], can_share: true });
    const { host, area } = await mount();
    await typeAt(area, "@");

    expect(host.textContent).toContain("No one else can open this document yet");
  });
});

describe("a guest's people list", () => {
  it("says plainly that it covers only people who can open the document", async () => {
    users.searchForMention.mockResolvedValue({ users: [], can_share: false, readers_only: true });
    const { host, area } = await mount();
    await typeAt(area, "@mi");

    expect(host.textContent).toContain("No one who can open this document matches “mi”");
  });
});

describe("choosing someone", () => {
  it("adds one space after the mention", async () => {
    const { host, area } = await mount();
    await typeAt(area, "Is it right, @om");
    await act(async () => options(host)[0]!.click());

    expect(value).toBe("Is it right, @omar ");
  });

  it("keeps the space that already follows instead of adding a second", async () => {
    const { host, area } = await mount();
    await typeAt(area, "Is it right, @om please confirm", "Is it right, @om".length);
    await act(async () => options(host)[0]!.click());

    expect(value).toBe("Is it right, @omar please confirm");
    expect(area.selectionStart).toBe("Is it right, @omar ".length);
    expect(options(host), "the list closes once someone is chosen").toEqual([]);
  });

  it("opens the list again for an @ typed where a chosen mention was deleted", async () => {
    const { host, area } = await mount();
    await typeAt(area, "@om");
    await act(async () => options(host)[0]!.click());
    expect(value).toBe("@omar ");

    await typeAt(area, "");
    await typeAt(area, "@");
    expect(options(host)).toHaveLength(2);
  });

  it("warns that someone who cannot open the document won't be notified, and offers Share", async () => {
    const { host, area } = await mount();
    await typeAt(area, "@");
    await act(async () => options(host)[1]!.click());

    expect(toasts.shown.map((t) => t.body)).toEqual(["Lin Wu can’t open this document, so they won’t be notified."]);
    expect((toasts.shown[0] as { endContent?: unknown }).endContent).toBeTruthy();
  });

  it("offers no Share to someone who may not share the document", async () => {
    users.searchForMention.mockResolvedValue({ users: [lin], can_share: false });
    const { host, area } = await mount();
    await typeAt(area, "@");
    await act(async () => options(host)[0]!.click());

    expect(toasts.shown).toHaveLength(1);
    expect((toasts.shown[0] as { endContent?: unknown }).endContent).toBeUndefined();
  });

  it("says nothing about someone who can open it", async () => {
    const { host, area } = await mount();
    await typeAt(area, "@");
    await act(async () => options(host)[0]!.click());

    expect(toasts.shown).toEqual([]);
  });
});

describe("a posted mention", () => {
  it("names the person as they are called now, keeping the handle as its title", async () => {
    // A person no search has cached yet, whose name the directory has since changed.
    users.resolve.mockResolvedValue({ users: [{ alias: "u_rana", username: "rana", display_name: "Rana Haddad-Lund", email: null }] });
    const { host, root } = mountInto();
    await act(async () => root.render(<CommentText body="@rana can you check?" mentions={[{ alias: "u_rana", username: "rana" }]} />));
    await act(async () => {});

    const chip = host.querySelector(".mention")!;
    expect(chip.textContent).toBe("@Rana Haddad-Lund");
    expect(chip.getAttribute("title")).toBe("@rana");
    expect(host.textContent).toBe("@Rana Haddad-Lund can you check?");
  });

  it("shows the handle as written until the name is known", async () => {
    users.resolve.mockResolvedValue({ users: [] });
    const { host, root } = mountInto();
    await act(async () => root.render(<CommentText body="ask @ghost" mentions={[{ alias: "u_ghost", username: "ghost" }]} />));
    await act(async () => {});

    expect(host.querySelector(".mention")!.textContent).toBe("@ghost");
  });
});
