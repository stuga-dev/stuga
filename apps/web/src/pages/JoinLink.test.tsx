// @vitest-environment jsdom
/** The invite page for someone signed in: what the link admits to, a dead link, and a member who is in already. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { mountInto } from "../test/form-input";

const api = vi.hoisted(() => ({
  whoami: vi.fn(),
  list: vi.fn(),
  redeemInvite: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("../api", () => ({
  Me: { whoami: api.whoami },
  Workspaces: { list: api.list, redeemInvite: api.redeemInvite },
  Docs: {},
}));
vi.mock("../lib/session/sign-in", () => ({ previewInvite: api.preview }));

const { JoinWorkspace } = await import("./JoinLink");

let host: HTMLDivElement;
let root: Root;
const assign = vi.fn();

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function open() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/join/inv_abc"]}>
        <Routes>
          <Route path="/join/:token" element={<JoinWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
  api.whoami.mockResolvedValue({ username: "sofia", alias: "u_sofia" });
  api.list.mockResolvedValue({ workspaces: [{ workspace_id: "w0", name: "Home", role: "owner" }], active: "w0" });
  ({ host, root } = mountInto());
});

describe("JoinWorkspace", () => {
  it("names the workspace, who invited and the role before joining", async () => {
    api.preview.mockResolvedValue({ status: "ok", workspace_id: "w1", workspace_name: "Bakery", role: "member", invited_by: "Liv" });
    await open();
    expect(api.preview).toHaveBeenCalledWith("inv_abc");
    expect(host.querySelector("h1")?.textContent).toBe("Join Bakery");
    expect(host.textContent).toContain("Liv invited you as a member.");
    expect(button("Join as @sofia")).toBeTruthy();
  });

  it("says a dead link is dead before anything is pressed", async () => {
    api.preview.mockResolvedValue({ status: "invalid" });
    await open();
    expect(host.querySelector("h1")?.textContent).toBe("Can’t join this workspace");
    expect(host.textContent).toContain("This invite link was used up, turned off or has expired.");
    expect(button("Join as @sofia")).toBeUndefined();
    expect(api.redeemInvite).not.toHaveBeenCalled();
  });

  it("tells a member they are in already and opens the workspace", async () => {
    api.preview.mockResolvedValue({ status: "ok", workspace_id: "w0", workspace_name: "Home", role: "member", invited_by: null });
    await open();
    expect(host.querySelector("h1")?.textContent).toBe("You’re already in Home");
    await act(async () => button("Open Home")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(assign).toHaveBeenCalledWith("/");
    expect(api.redeemInvite).not.toHaveBeenCalled();
  });

  it("names a workspace from the member's own list when the link works only locally", async () => {
    api.preview.mockResolvedValue({ status: "local_only", workspace_id: "w0" });
    await open();
    expect(host.querySelector("h1")?.textContent).toBe("You’re already in Home");
  });

  it("says a local-only link opens only on the node's network", async () => {
    api.preview.mockResolvedValue({ status: "local_only", workspace_id: "w1" });
    await open();
    expect(host.textContent).toContain("This invite link works only on this node’s network.");
    expect(button("Join as @sofia")).toBeUndefined();
  });
});
