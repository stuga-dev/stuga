// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { UserInfo } from "../api";
import { mountInto, typeInto } from "../test/form-input";

const docs = vi.hoisted(() => ({
  getAcl: vi.fn(),
  setAcl: vi.fn(),
  createShareLink: vi.fn(),
  shareLinks: vi.fn(),
  revokeShareLink: vi.fn(),
  setShareLinkRole: vi.fn(),
  accessRequests: vi.fn(),
  dismissAccessRequest: vi.fn(),
}));
const folders = vi.hoisted(() => ({ getAcl: vi.fn(), setAcl: vi.fn() }));
const groups = vi.hoisted(() => ({ list: vi.fn() }));
const workspaces = vi.hoisted(() => ({ list: vi.fn(), members: vi.fn() }));
const users = vi.hoisted(() => ({ search: vi.fn(), resolve: vi.fn() }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Docs: docs,
  Workspaces: workspaces,
  Folders: folders,
  Groups: groups,
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
  can_manage: true,
};

const LINK = "http://192.168.1.10:8787/s/shl_s3cr3t-token";
const LIVE = { token_hash: "h1", role: "viewer", created_by: "owner-1", created_at: "2026-10-01T00:00:00Z", expires_at: null, link_url: LINK };

let host: HTMLDivElement;
let root: Root;

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
  vi.clearAllMocks();
  docs.getAcl.mockResolvedValue(ACL);
  docs.setAcl.mockResolvedValue({});
  docs.createShareLink.mockResolvedValue({ link_url: LINK });
  docs.shareLinks.mockResolvedValue({ links: [] });
  docs.revokeShareLink.mockResolvedValue({ revoked: true });
  docs.accessRequests.mockResolvedValue({ requests: [] });
  docs.dismissAccessRequest.mockResolvedValue({ dismissed: 1 });
  // Planning itself: Carol may edit there.
  folders.getAcl.mockResolvedValue({ ...ACL, parent: null, acl_writers: ["user:owner-1", "user:carol"] });
  groups.list.mockResolvedValue({ groups: [{ group_id: "group:Kitchen", members: ["user:carol"], updated_at: "" }, { group_id: "group:Empty", members: [], updated_at: "" }] });
  workspaces.list.mockResolvedValue(null);
  workspaces.members.mockResolvedValue({ members: [] });
  users.resolve.mockResolvedValue({ users: [] });
  users.search.mockResolvedValue({
    users: [{ alias: "u-ada", username: "ada", display_name: "Ada Lovelace", email: null }],
  });
  ({ host, root } = mountInto());
  await act(async () => {
    root.render(<ShareDialog docId="doc1" onClose={() => {}} />);
  });
});

/** Picks `label` in the combobox `name` labels. */
async function pick(name: string, label: string) {
  // A hidden label still names its control with `for`.
  const named = [...host.querySelectorAll("label")].find((l) => l.textContent === name);
  const trigger = named ? document.getElementById(named.htmlFor) : null;
  if (!trigger) throw new Error(`no menu ${name}`);
  await act(async () => trigger.click());
  const listbox = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  const option = [...(listbox ?? document).querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes(label));
  if (!option) throw new Error(`no option ${label}`);
  await act(async () => option.click());
}

describe("share link", () => {
  it("says the link is off until one exists, and makes nothing on its own", () => {
    expect(host.textContent).toContain("Turn it on to get a link to send.");
    expect(() => findButton("Copy link")).toThrow();
    expect(docs.createShareLink).not.toHaveBeenCalled();
  });

  it("makes one link when turned on, and shows it to copy", async () => {
    docs.shareLinks.mockResolvedValue({ links: [LIVE] });
    await pick("Link role", "Can view");

    expect(docs.createShareLink).toHaveBeenCalledWith("doc1", { role: "viewer" });
    expect(inputValues()).toContain(LINK);
    expect(host.textContent).toContain("Anyone with an account here can open it with the link.");
  });

  it("copies the live link instead of making another", async () => {
    docs.shareLinks.mockResolvedValue({ links: [LIVE] });
    await act(async () => root.render(<ShareDialog docId="doc3" onClose={() => {}} />));
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });

    await act(async () => findButton("Copy link").click());
    await act(async () => findButton("Copied").click());

    expect(docs.createShareLink).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(LINK);
  });

  it("does not claim a copy where the clipboard does not exist, and still shows the link", async () => {
    docs.shareLinks.mockResolvedValue({ links: [LIVE] });
    await act(async () => root.render(<ShareDialog docId="doc3" onClose={() => {}} />));
    setClipboard(undefined);

    await act(async () => findButton("Copy link").click());

    expect(inputValues()).toContain(LINK);
    expect(host.textContent).not.toContain("Copied");
  });

  it("changes the link's level at the same address, so a link already sent keeps working", async () => {
    docs.shareLinks.mockResolvedValueOnce({ links: [LIVE] }).mockResolvedValue({ links: [{ ...LIVE, role: "editor" }] });
    await act(async () => root.render(<ShareDialog docId="doc3" onClose={() => {}} />));

    await pick("Link role", "Can edit");

    expect(docs.setShareLinkRole).toHaveBeenCalledWith("doc3", "h1", "editor");
    expect(docs.createShareLink).not.toHaveBeenCalled();
    expect(docs.revokeShareLink).not.toHaveBeenCalled();
    expect(inputValues()).toContain(LINK);
  });

  it("turns the link off only after saying who keeps access", async () => {
    docs.shareLinks.mockResolvedValueOnce({ links: [LIVE] }).mockResolvedValue({ links: [] });
    await act(async () => root.render(<ShareDialog docId="doc3" onClose={() => {}} />));

    await pick("Link role", "Off");
    expect(docs.revokeShareLink).not.toHaveBeenCalled();
    expect(host.textContent).toContain("People who already opened it keep their access until you remove them.");

    await act(async () => findButton("Turn off").click());
    expect(docs.revokeShareLink).toHaveBeenCalledWith("doc3", "h1");
    expect(host.textContent).toContain("Turn it on to get a link to send.");
  });
});

describe("add people", () => {
  // The search's debounce runs on fake time.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Types into the picker the way a person does, then lets the debounced search land. */
  async function type(text: string) {
    const input = host.querySelector<HTMLInputElement>('input[placeholder^="Add people"]')!;
    await act(async () => input.focus());
    await typeInto(input, text);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
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

  it("adds someone as Can view", async () => {
    await type("ad");
    await act(async () => option("Ada Lovelace").click());

    await act(async () => findButton("Save").click());
    expect(docs.setAcl).toHaveBeenCalledWith("doc1", ["user:u-ada"], [], true, []);
  });

  it("suggests the workspace's groups by name, and says when one is empty", async () => {
    await type("kit");
    expect(option("Kitchen (group)").textContent).toContain("1 person");
    await act(async () => option("Kitchen (group)").click());
    expect(host.querySelector(".grant-list")?.textContent).toContain("Kitchen (group)");

    await type("group:emp");
    expect(users.search).not.toHaveBeenCalledWith("group:emp", expect.anything());
    await act(async () => option("Empty (group)").click());
    expect(host.querySelector(".grant-list")?.textContent).toContain("No one in this group yet");
  });

  it("refuses a group nobody made", async () => {
    await type("group:Teachers");

    expect(document.body.textContent).toContain("No group is called “Teachers”.");
    expect([...document.querySelectorAll('[role="option"]')].some((o) => o.textContent?.includes("Teachers (group)"))).toBe(false);
  });

  it("says the search needs two letters", async () => {
    const input = host.querySelector<HTMLInputElement>('input[placeholder^="Add people"]')!;
    await act(async () => input.focus());
    await typeInto(input, "a");
    expect(host.textContent).toContain("Type at least two letters.");
  });
});

describe("inheritance", () => {
  function listText(): string {
    return host.querySelector(".grant-list")?.textContent ?? "";
  }

  it("shows the owner as the owner, and the folder's people at the level it gives them", () => {
    expect(listText()).toContain("Owner");
    expect(listText()).toContain("Can edit via Planning");
    expect(listText().match(/via Planning/g)).toHaveLength(1);
  });

  it("says when the folder gives a person more than their own grant", async () => {
    docs.getAcl.mockResolvedValue({ ...ACL, own_grants: { p: ["user:carol"], w: [], c: [] }, acl_writers: ["user:owner-1", "user:carol"] });
    await act(async () => root.render(<ShareDialog docId="doc4" onClose={() => {}} />));

    // Carol's own row says Can view; the folder lets her edit, and the row says so.
    expect(listText()).toContain("Can edit via Planning");
  });

  /** Picks an option in the parent folder's access menu. */
  function confirmButton(): HTMLButtonElement | undefined {
    return [...host.querySelectorAll("button")].find((b) => b.textContent === "Stop inheriting");
  }

  it("asks in place before it stops inheriting, then saves without the folder's access", async () => {
    await pick("Parent folder access", "No access");
    // Nothing changes until the confirmation is accepted, and it sits in this dialog, not over it.
    expect(listText()).toContain("via Planning");
    expect(confirmButton()).toBeDefined();
    expect(document.querySelector("[role='alertdialog']")).toBeNull();

    await act(async () => confirmButton()!.click());

    expect(listText()).toContain("Removed on save");
    expect(listText()).toContain("Owner");
    await act(async () => findButton("Save").click());
    expect(docs.setAcl).toHaveBeenCalledWith("doc1", [], [], false, []);
  });

  it("keeps inheriting when the confirmation is cancelled", async () => {
    await pick("Parent folder access", "No access");
    const cancel = confirmButton()!.parentElement!.querySelector("button")!;
    expect(cancel.textContent).toBe("Cancel");
    await act(async () => cancel.click());

    expect(confirmButton()).toBeUndefined();
    expect(listText()).toContain("via Planning");
    await act(async () => findButton("Save").click());
    expect(docs.setAcl).toHaveBeenCalledWith("doc1", [], [], true, []);
  });
});

describe("who may change it", () => {
  it("shows a viewer the sharing read-only, with nothing to save", async () => {
    docs.getAcl.mockResolvedValue({ ...ACL, can_manage: false, own_grants: { p: ["user:carol"], w: [], c: [] } });
    await act(async () => root.render(<ShareDialog docId="doc5" onClose={() => {}} />));

    expect(host.textContent).toContain("Only the owner or a workspace admin can change sharing.");
    expect(() => findButton("Save")).toThrow();
    expect(host.querySelector('[role="combobox"]')).toBeNull();
    expect(host.querySelector('input[placeholder^="Add people"]')).toBeNull();
    expect(docs.shareLinks).not.toHaveBeenCalledWith("doc5");
  });

  it("goes back to what is in force when a save is refused", async () => {
    docs.setAcl.mockRejectedValue(Object.assign(new Error("only the owner"), { status: 403 }));
    await pick("General access", "Can edit");
    const before = docs.getAcl.mock.calls.length;

    await act(async () => findButton("Save").click());

    expect(docs.getAcl.mock.calls.length).toBe(before + 1);
    expect(host.textContent).toContain("Couldn’t share");
  });

  it("confirms a save", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<ShareDialog docId="doc6" onClose={onClose} />));
    await act(async () => findButton("Save").click());
    expect(onClose).toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sharing updated");
  });
});

describe("guests", () => {
  it("marks a guest of the workspace on their row", async () => {
    workspaces.list.mockResolvedValue({ active: "ws1", workspaces: [{ workspace_id: "ws1", name: "Bakery", role: "owner" }] });
    workspaces.members.mockResolvedValue({
      members: [
        { alias: "gus", role: "guest", display_name: "Gus", username: "gus", email: null },
        { alias: "carol", role: "member", display_name: "Carol", username: "carol", email: null },
      ],
    });
    docs.getAcl.mockResolvedValue({ ...ACL, acl_principals: [...ACL.acl_principals, "user:gus"], own_grants: { p: ["user:gus"], w: [], c: [] } });
    await act(async () => root.render(<ShareDialog docId="doc9" onClose={() => {}} />));

    expect(workspaces.members).toHaveBeenCalledWith("ws1");
    const rows = [...host.querySelectorAll(".grant-list li")].map((li) => li.textContent ?? "");
    expect(rows.filter((r) => r.includes("Guest"))).toHaveLength(1);
  });
});

describe("access requests", () => {
  it("lists who asked and adds them at the level picked", async () => {
    docs.accessRequests.mockResolvedValue({ requests: [{ principal: "user:dana", requested_at: new Date().toISOString() }] });
    await act(async () => root.render(<ShareDialog docId="doc7" onClose={() => {}} />));
    expect(host.textContent).toContain("Asking for access");

    const trigger = host.querySelector<HTMLElement>(".request-list [role='combobox']")!;
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === "Can comment")!;
    await act(async () => option.click());

    expect(host.textContent).not.toContain("Asking for access");
    await act(async () => findButton("Save").click());
    expect(docs.setAcl).toHaveBeenCalledWith("doc7", ["user:dana"], [], true, ["user:dana"]);
  });

  it("dismisses a request at once", async () => {
    docs.accessRequests.mockResolvedValue({ requests: [{ principal: "user:dana", requested_at: new Date().toISOString() }] });
    await act(async () => root.render(<ShareDialog docId="doc8" onClose={() => {}} />));

    const trigger = host.querySelector<HTMLElement>(".request-list [role='combobox']")!;
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === "Dismiss")!;
    await act(async () => option.click());

    expect(docs.dismissAccessRequest).toHaveBeenCalledWith("doc8", "user:dana");
    expect(host.textContent).not.toContain("Asking for access");
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

  it("shows no raw id while names load, then the names", async () => {
    const ada: UserInfo = { alias: "u_QH52ada7RzkP4mXe", username: "ada", display_name: "Ada", email: null };
    const bob: UserInfo = { alias: "u_Bb81bob4TqeW9nJs", username: "bob", display_name: "Bob", email: null };
    const cy: UserInfo = { alias: "u_Cr0lcarol5Xy2WkQ", username: "cy", display_name: "Cy", email: null };
    let answer!: (r: { users: UserInfo[] }) => void;
    users.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    await reopen(`user:${ada.alias}`, `user:${bob.alias}`, `user:${cy.alias}`);

    expect(users.resolve).toHaveBeenCalledWith([ada.alias, cy.alias, bob.alias]);
    expect(listText()).toContain("Owner");
    expect(listText()).toContain("via Planning");
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
      ["A", "Ada"],
      ["C", "Cy"],
      ["B", "Bob"],
    ]);
  });
});
