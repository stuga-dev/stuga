// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UserInfo } from "../api";

const docs = vi.hoisted(() => ({
  getAcl: vi.fn(),
  setAcl: vi.fn(),
  createShareLink: vi.fn(),
}));
const workspaces = vi.hoisted(() => ({ list: vi.fn() }));
const users = vi.hoisted(() => ({ search: vi.fn(), resolve: vi.fn() }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Docs: docs,
  Workspaces: workspaces,
  Folders: { getAcl: vi.fn(), setAcl: vi.fn() },
  Users: users,
}));

const { ShareDialog } = await import("./ShareDialog");

/** In folder Planning, which gives Carol access; the owner is in neither list. */
const ACL = {
  parent: { folder_id: "f1", title: "Planning" },
  owner: "user:owner-1",
  acl_principals: ["user:owner-1", "user:carol"],
  acl_writers: ["user:owner-1"],
  acl_commenters: [],
  inherits: true,
  own_grants: { p: [], w: [], c: [] },
};

const LINK = "http://192.168.1.10:8787/join/doc/s3cr3t-token";

let host: HTMLDivElement;
let root: Root;

// jsdom's <dialog> has no showModal/close, which Astryx Dialog calls.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

/** Replace navigator.clipboard for one test; `undefined` models a plain-http origin. */
function setClipboard(value: { writeText: (t: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}

function findButton(label: string): HTMLButtonElement {
  const all = [...host.querySelectorAll("button")];
  const hit = all.find((b) => b.textContent?.includes(label));
  if (!hit) throw new Error(`no button labelled ${label}; saw: ${all.map((b) => b.textContent).join(" | ")}`);
  return hit as HTMLButtonElement;
}

/** Every rendered input value — where a recoverable link would have to appear. */
function inputValues(): string[] {
  return [...host.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value);
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  docs.getAcl.mockResolvedValue(ACL);
  docs.setAcl.mockResolvedValue({});
  docs.createShareLink.mockResolvedValue({ link_url: LINK });
  workspaces.list.mockResolvedValue(null);
  users.resolve.mockResolvedValue({ users: [] });
  users.search.mockResolvedValue({
    users: [{ alias: "u-ada", username: "ada", display_name: "Ada Lovelace", email: null }],
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<ShareDialog docId="doc1" onClose={() => {}} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("share link", () => {
  it("shows the minted URL on an insecure origin, where the clipboard does not exist", async () => {
    setClipboard(undefined);

    await act(async () => findButton("Copy link").click());

    expect(docs.createShareLink).toHaveBeenCalledTimes(1);
    expect(inputValues()).toContain(LINK);
    expect(host.textContent).not.toContain("Copied");
  });

  it("copies and says so on a secure origin, and still renders the URL", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });

    await act(async () => findButton("Copy link").click());

    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(host.textContent).toContain("Copied");
    expect(inputValues()).toContain(LINK);
  });

  it("does not claim a copy when the clipboard exists but rejects", async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("denied"))) });

    await act(async () => findButton("Copy link").click());

    expect(inputValues()).toContain(LINK);
    expect(host.textContent).not.toContain("Copied");
  });
});

describe("add people", () => {
  /** Types into the picker the way a person does, then lets the debounced search land. */
  async function type(text: string) {
    const input = host.querySelector<HTMLInputElement>('input[placeholder^="Add by"]')!;
    await act(async () => {
      input.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
  }

  function option(text: string): HTMLElement {
    const hit = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes(text));
    if (!hit) throw new Error(`no option ${text}`);
    return hit;
  }

  it("suggests people as you type and adds the one picked", async () => {
    await type("ad");

    expect(users.search).toHaveBeenCalledWith("ad", expect.anything());
    expect(option("Ada Lovelace").textContent).toContain("@ada");

    await act(async () => option("Ada Lovelace").click());

    expect(host.querySelector(".grant-list")?.textContent).toContain("Ada Lovelace");
  });

  it("offers a typed group without searching the directory", async () => {
    await type("group:eng");

    expect(users.search).not.toHaveBeenCalled();
    await act(async () => option("group:eng").click());

    expect(host.querySelector(".grant-list")?.textContent).toContain("eng");
  });
});

describe("inheritance", () => {
  function listText(): string {
    return host.querySelector(".grant-list")?.textContent ?? "";
  }

  it("shows the owner as the owner, never as inherited", () => {
    expect(listText()).toContain("Owner");
    expect(listText()).toContain("From Planning");
    expect(listText().match(/From Planning/g)).toHaveLength(1);
  });

  /** Picks an option in the parent folder's access menu. */
  async function pickFolderAccess(label: string) {
    const trigger = host.querySelector<HTMLElement>('[role="combobox"][aria-label="Parent folder access"]')
      ?? [...host.querySelectorAll<HTMLElement>('[role="combobox"]')].find((c) => c.textContent?.includes("Inherited"));
    if (!trigger) throw new Error("no parent folder access menu");
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes(label));
    if (!option) throw new Error(`no option ${label}`);
    await act(async () => option.click());
  }

  function confirmButton(): HTMLButtonElement | undefined {
    return [...document.querySelectorAll("button")].find((b) => b.textContent === "Stop inheriting");
  }

  it("asks before it stops inheriting, then saves without the folder's access", async () => {
    await pickFolderAccess("No access");
    // Nothing changes until the confirmation is accepted.
    expect(listText()).toContain("From Planning");
    expect(confirmButton()).toBeDefined();

    await act(async () => confirmButton()!.click());

    expect(listText()).toContain("Removed on save");
    expect(listText()).toContain("Owner");
    await act(async () => findButton("Save").click());
    expect(docs.setAcl).toHaveBeenCalledWith("doc1", [], [], false, []);
  });

  it("keeps inheriting when the confirmation is cancelled", async () => {
    await pickFolderAccess("No access");
    // The confirmation's own Cancel, not the Share dialog's.
    const alert = confirmButton()!.closest("dialog, [role='alertdialog']")!;
    const cancel = [...alert.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    expect(alert.contains(findButton("Save"))).toBe(false);
    await act(async () => cancel.click());

    expect(listText()).toContain("From Planning");
    await act(async () => findButton("Save").click());
    expect(docs.setAcl).toHaveBeenCalledWith("doc1", [], [], true, []);
  });
});

// The name cache lives for the file, so each case names its own people.
describe("people with access", () => {
  function listText(): string {
    return host.querySelector(".grant-list")?.textContent ?? "";
  }
  const avatars = () => [...host.querySelectorAll<HTMLElement>(".grant-list .avatar")];

  /** Reopens the dialog on a document the owner shares with one other person through the folder, and maybe one directly. */
  async function reopen(owner: string, other: string, direct?: string) {
    const principals = [owner, other, ...(direct ? [direct] : [])];
    const own_grants = { p: direct ? [direct] : [], w: [], c: [] };
    docs.getAcl.mockResolvedValue({ ...ACL, owner, acl_principals: principals, acl_writers: [owner], own_grants });
    await act(async () => root.render(<ShareDialog docId="doc2" onClose={() => {}} />));
  }

  it("falls back to the short id once the lookup fails", async () => {
    users.resolve.mockRejectedValue(new Error("offline"));
    await reopen("user:u_Kcjz0unreachable", "user:u_Wq7L0unreachable");

    expect(users.resolve).toHaveBeenCalledWith(["u_Kcjz0unreachable", "u_Wq7L0unreachable"]);
    expect(listText()).toContain("u_Kcjz…");
    expect(listText()).toContain("u_Wq7L…");
  });

  it("shows no raw id while names load, then the names", async () => {
    const ada: UserInfo = { alias: "u_QH52ada7RzkP4mXe", username: "ada", display_name: "Ada", email: null };
    const bob: UserInfo = { alias: "u_Bb81bob4TqeW9nJs", username: "bob", display_name: "Bob", email: null };
    const cy: UserInfo = { alias: "u_Cr0lcarol5Xy2WkQ", username: "cy", display_name: "Cy", email: null };
    let answer!: (r: { users: UserInfo[] }) => void;
    users.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    await reopen(`user:${ada.alias}`, `user:${bob.alias}`, `user:${cy.alias}`);

    expect(users.resolve).toHaveBeenCalledWith([ada.alias, cy.alias, bob.alias]);
    expect(listText()).toContain("Owner");
    expect(listText()).toContain("From Planning");
    // Nor in a hidden label or a tooltip.
    expect(host.querySelector(".grant-list")!.innerHTML).not.toMatch(/u_QH52|u_Bb81|u_Cr0l/);
    // Each avatar is its colour alone.
    expect(avatars().map((a) => [a.textContent, a.title])).toEqual([
      ["", ""],
      ["", ""],
      ["", ""],
    ]);

    await act(async () => answer({ users: [ada, bob, cy] }));
    expect(listText()).toContain("Ada");
    expect(listText()).toContain("Bob");
    expect(listText()).toContain("Cy");
    expect(avatars().map((a) => [a.textContent, a.title])).toEqual([
      ["AD", "Ada"],
      ["CY", "Cy"],
      ["BO", "Bob"],
    ]);
  });
});
