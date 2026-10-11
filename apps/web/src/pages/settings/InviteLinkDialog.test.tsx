// @vitest-environment jsdom
/** The invite dialog: the limits it asks for, and the open links it leaves out at the remote address. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { dropdown, mountInto, typeInto } from "../../test/form-input";

const workspaces = vi.hoisted(() => ({ createInvite: vi.fn() }));
const linkAddresses = vi.hoisted(() => vi.fn());
vi.mock("../../api", async (orig) => {
  const real = await orig<typeof import("../../api")>();
  return { ...real, Workspaces: workspaces, Me: { ...real.Me, linkAddresses } };
});
vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

const { setAuthConfigForTest } = await import("../../lib/session/auth-config");
const { InviteLinkDialog } = await import("./InviteLinkDialog");

const REMOTE = "https://k7f3q2.mystuga.com";
const originalLocation = window.location;
let root: Root;

beforeEach(() => {
  ({ root } = mountInto());
  workspaces.createInvite.mockReset();
  workspaces.createInvite.mockResolvedValue({ join_url: "http://node.test/join/x" });
  // Remote access off: no choice, as before it existed.
  linkAddresses.mockReset();
  linkAddresses.mockResolvedValue({ remote: false, local: "network", default: "local" });
});
afterEach(() => {
  act(() => root.unmount());
  setAuthConfigForTest(null);
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

async function open() {
  await act(async () =>
    root.render(<InviteLinkDialog isOpen workspaceId="ws1" canInviteAdmin onCreated={() => {}} onClose={() => {}} />),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}
const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label)!;

/** The options a dropdown offers, opened and closed again. */
async function optionsOf(label: string): Promise<string[]> {
  const trigger = dropdown(document, label);
  await click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const options = [...listbox.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
  await click(trigger);
  return options;
}

async function choose(label: string, option: string): Promise<void> {
  const trigger = dropdown(document, label);
  await click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  await click([...listbox.querySelectorAll('[role="option"]')].find((o) => o.textContent === option)!);
}

describe("the invite dialog", () => {
  it("asks for one person and seven days, and says so to the node", async () => {
    await open();
    await click(button("Create link"));
    expect(workspaces.createInvite).toHaveBeenCalledWith("ws1", { role: "member", max_uses: 1, expires_in_days: 7 });
  });

  it("asks for a link with no limit and no expiry in so many words, on the node's own network", async () => {
    await open();
    await choose("Can be used", "No limit");
    await choose("Expires after", "Never");
    await click(button("Create link"));
    expect(workspaces.createInvite).toHaveBeenCalledWith("ws1", { role: "member", max_uses: null, expires_in_days: null });
  });

  it("offers neither at the remote address, where the link would be an open sign-up", async () => {
    setAuthConfigForTest({ remoteOrigin: REMOTE });
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, origin: REMOTE } });
    // Made there, a link is for someone anywhere unless its maker says otherwise.
    linkAddresses.mockResolvedValue({ remote: true, local: "network", default: "remote" });
    await open();
    expect(await optionsOf("Can be used")).not.toContain("No limit");
    expect(await optionsOf("Expires after")).not.toContain("Never");
    expect(await optionsOf("Expires after")).toContain("30 days");
  });

  it("asks who the link is for while remote access is on, the maker's own address first", async () => {
    linkAddresses.mockResolvedValue({ remote: true, local: "network", default: "local" });
    await open();
    expect(document.body.textContent).toContain("For someone on this network");
    await click(button("Create link"));
    expect(workspaces.createInvite).toHaveBeenCalledWith("ws1", { role: "member", max_uses: 1, expires_in_days: 7, address: "local" });
    expect(document.body.textContent).toContain("Opens on any device on this network.");
  });

  it("for someone anywhere, offers no open link and goes back to one person and seven days", async () => {
    linkAddresses.mockResolvedValue({ remote: true, local: "network", default: "local" });
    await open();
    await choose("Can be used", "No limit");
    await choose("Expires after", "Never");
    await click([...document.querySelectorAll("button, [role=radio]")].find((b) => b.textContent === "For someone anywhere")!);
    expect(await optionsOf("Can be used")).not.toContain("No limit");
    expect(await optionsOf("Expires after")).not.toContain("Never");
    await click(button("Create link"));
    expect(workspaces.createInvite).toHaveBeenCalledWith("ws1", { role: "member", max_uses: 1, expires_in_days: 7, address: "remote" });
    expect(document.body.textContent).not.toContain("Opens only on");
    expect(document.body.textContent).toContain("Opens on any device, anywhere.");
  });

  it("calls the node's own side this computer, and starts on anywhere, when that is all it reaches", async () => {
    linkAddresses.mockResolvedValue({ remote: true, local: "computer", default: "remote" });
    await open();
    expect(document.body.textContent).toContain("For someone on this computer");
    await click(button("Create link"));
    expect(workspaces.createInvite).toHaveBeenCalledWith("ws1", { role: "member", max_uses: 1, expires_in_days: 7, address: "remote" });
  });

  it("a limit chosen before it learns the link is for anywhere falls back to one person and seven days", async () => {
    let answer: (a: unknown) => void = () => {};
    linkAddresses.mockReturnValue(new Promise((r) => (answer = r)));
    await open();
    await choose("Can be used", "No limit");
    await choose("Expires after", "Never");
    await act(async () => answer({ remote: true, local: "computer", default: "remote" }));
    await click(button("Create link"));
    expect(workspaces.createInvite).toHaveBeenCalledWith("ws1", { role: "member", max_uses: 1, expires_in_days: 7, address: "remote" });
  });

  it("says a link opens only on this computer when the node is reachable nowhere else", async () => {
    linkAddresses.mockResolvedValue({ remote: false, local: "computer", default: "local" });
    await open();
    expect(document.body.textContent).not.toContain("For someone");
    await click(button("Create link"));
    expect(workspaces.createInvite).toHaveBeenCalledWith("ws1", { role: "member", max_uses: 1, expires_in_days: 7 });
    expect(document.body.textContent).toContain("Opens only on this computer. Other devices can’t reach this node at this address.");
  });

  it("says a link works on other devices when the node's address does", async () => {
    await open();
    await click(button("Create link"));
    expect(document.body.textContent).toContain("Opens on any device on this network.");
    expect(document.body.textContent).not.toContain("only on this computer");
  });

  it("sends who the link is for, trimmed, when the maker says", async () => {
    await open();
    const field = [...document.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Who it’s for"));
    await typeInto(document.getElementById(field!.htmlFor) as HTMLInputElement, "  Sofia ");
    await click(button("Create link"));
    expect(workspaces.createInvite).toHaveBeenCalledWith("ws1", { role: "member", max_uses: 1, expires_in_days: 7, note: "Sofia" });
  });
});
