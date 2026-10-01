// @vitest-environment jsdom
/** The invite dialog: the limits it asks for, and the open links it leaves out at the remote address. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { dropdown, mountInto } from "../../test/form-input";

const workspaces = vi.hoisted(() => ({ createInvite: vi.fn() }));
vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  Workspaces: workspaces,
}));
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
    await open();
    expect(await optionsOf("Can be used")).not.toContain("No limit");
    expect(await optionsOf("Expires after")).not.toContain("Never");
    expect(await optionsOf("Expires after")).toContain("30 days");
  });
});
