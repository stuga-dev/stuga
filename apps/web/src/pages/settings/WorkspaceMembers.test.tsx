// @vitest-environment jsdom
/** Members: the only owner, leaving and removing in words, ownership asked first, and invite links named and turned off with a confirmation. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { InviteInfo, MemberInfo } from "../../api";
import { dropdown, mountInto } from "../../test/form-input";

const workspaces = vi.hoisted(() => ({
  members: vi.fn(),
  listInvites: vi.fn(),
  setRole: vi.fn(async () => ({})),
  revokeInvite: vi.fn(async () => ({ revoked: true })),
  remove: vi.fn(async () => ({})),
}));
const scope = vi.hoisted(() => ({ canManage: true, isOwner: true, me: "u_liv" }));

vi.mock("../../api", async (orig) => {
  const api = await orig<typeof import("../../api")>();
  return { ...api, Workspaces: { ...api.Workspaces, ...workspaces } };
});
vi.mock("@astryxdesign/core/Toast", () => import("../../test/toast"));
vi.mock("./SettingsLayout", () => ({
  useSettingsScope: () => ({
    isReady: true,
    workspace: { workspace_id: "ws1", name: "Bakery", role: scope.isOwner ? "owner" : "member" },
    reload: vi.fn(async () => {}),
    ...scope,
  }),
}));

const { WorkspaceMembers } = await import("./WorkspaceMembers");

let host: HTMLDivElement;
let root: Root;

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** Buttons on the page, not in a dialog. */
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent === label && !b.closest("dialog"));
const dialogButton = (label: string) => [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === label);
const dialogText = () => [...document.querySelectorAll("dialog[open]")].map((d) => d.textContent).join(" ");

function member(alias: string, name: string, role: MemberInfo["role"]): MemberInfo {
  return { workspace_id: "ws1", alias, role, joined_at: "2026-09-01T00:00:00Z", display_name: name, username: alias.slice(2), email: null };
}

const LINK: InviteInfo = {
  token_hash: "h1",
  token_hint: "Ab12",
  role: "guest",
  note: "Sofia",
  created_by: "u_liv",
  created_at: "2026-10-01T00:00:00Z",
  expires_at: null,
  max_uses: 1,
  use_count: 0,
} as InviteInfo;

async function open(members: MemberInfo[]) {
  workspaces.members.mockResolvedValue({ members });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <WorkspaceMembers />
      </MemoryRouter>,
    );
  });
  await settle();
}

async function click(el: Element | undefined) {
  expect(el).toBeTruthy();
  await act(async () => void el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}

async function choose(label: string, option: string) {
  const trigger = dropdown(host, label);
  await click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  await click([...listbox.querySelectorAll('[role="option"]')].find((o) => o.textContent === option));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(scope, { canManage: true, isOwner: true, me: "u_liv" });
  workspaces.listInvites.mockResolvedValue({ invites: [LINK] });
  ({ host, root } = mountInto());
});

describe("WorkspaceMembers", () => {
  it("tells the only owner so where Leave would be, and removes others with a labelled button", async () => {
    await open([member("u_liv", "Liv", "owner"), member("u_sofia", "Sofia Alvarez", "member")]);
    expect(host.textContent).toContain("You’re the only owner");
    expect(buttons("Leave workspace")).toHaveLength(0);
    expect(buttons("Remove")).toHaveLength(1);
    expect(host.textContent).toContain("Owners manage everything");
  });

  it("asks before making someone an owner, and says what an owner can do", async () => {
    await open([member("u_liv", "Liv", "owner"), member("u_sofia", "Sofia Alvarez", "member")]);
    await choose("Role of Sofia Alvarez", "Owner");
    expect(workspaces.setRole).not.toHaveBeenCalled();
    expect(dialogText()).toContain("Make Sofia Alvarez an owner?");
    expect(dialogText()).toContain("delete the workspace");
    await click(dialogButton("Make owner"));
    expect(workspaces.setRole).toHaveBeenCalledWith("ws1", "u_sofia", "owner");
  });

  it("asks before an owner gives up their own ownership, and changes other roles at once", async () => {
    await open([member("u_liv", "Liv", "owner"), member("u_ada", "Ada", "owner"), member("u_sofia", "Sofia Alvarez", "member")]);
    expect(buttons("Leave workspace")).toHaveLength(1);
    await choose("Role of Liv", "Admin");
    expect(workspaces.setRole).not.toHaveBeenCalled();
    expect(dialogText()).toContain("Stop being an owner?");
    await click(dialogButton("Change my role"));
    expect(workspaces.setRole).toHaveBeenCalledWith("ws1", "u_liv", "admin");

    await choose("Role of Sofia Alvarez", "Guest");
    expect(workspaces.setRole).toHaveBeenLastCalledWith("ws1", "u_sofia", "guest");
  });

  it("lists who a link is for, and turns it off only after asking", async () => {
    await open([member("u_liv", "Liv", "owner")]);
    expect(host.textContent).toContain("For Sofia · Guest");
    await click(buttons("Turn off link")[0]);
    expect(workspaces.revokeInvite).not.toHaveBeenCalled();
    expect(dialogText()).toContain("Turn off the invite link for Sofia?");
    await click(dialogButton("Turn off link"));
    expect(workspaces.revokeInvite).toHaveBeenCalledWith("ws1", "h1");
  });

  it("shows a member only their own Leave, and roles as badges", async () => {
    Object.assign(scope, { canManage: false, isOwner: false, me: "u_sofia" });
    await open([member("u_liv", "Liv", "owner"), member("u_sofia", "Sofia Alvarez", "member")]);
    expect(buttons("Leave workspace")).toHaveLength(1);
    expect(buttons("Remove")).toHaveLength(0);
    expect([...host.querySelectorAll("label")].some((l) => l.textContent?.startsWith("Role of"))).toBe(false);
  });

  it("gives an admin no menu or Remove on an owner's row", async () => {
    Object.assign(scope, { canManage: true, isOwner: false, me: "u_ada" });
    await open([member("u_liv", "Liv", "owner"), member("u_ada", "Ada", "admin"), member("u_sofia", "Sofia Alvarez", "member")]);
    expect([...host.querySelectorAll("label")].filter((l) => l.textContent?.startsWith("Role of")).map((l) => l.textContent)).toEqual([
      "Role of Sofia Alvarez",
    ]);
    expect(buttons("Remove")).toHaveLength(1);
  });
});
