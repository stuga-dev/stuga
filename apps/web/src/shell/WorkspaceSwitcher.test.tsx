// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OtherNode } from "../api";

const workspaces = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
const otherNodes = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn(), onChanged: vi.fn() }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Workspaces: workspaces,
  onWorkspaceListChanged: () => () => {},
  OtherNodes: otherNodes,
}));
vi.mock("@astryxdesign/core/Toast", () => ({ useToast: () => () => {} }));

interface MenuRow {
  type?: "divider" | "section";
  id?: string;
  title?: string;
  label?: string;
  description?: string;
  isDisabled?: boolean;
  onClick?: () => void;
  items?: MenuRow[];
}

/** The rows last handed to the menu, to reach a handler a disabled button would not run. */
const menu = vi.hoisted(() => ({ items: [] as MenuRow[] }));

// The menu stands in as its rows: a section's title when it has one, as Astryx renders it, then each row as a button.
vi.mock("@astryxdesign/core/DropdownMenu", () => ({
  DropdownMenu: ({ items }: { items: MenuRow[] }) => {
    menu.items = items;
    const row = (item: MenuRow) => (
      <button key={item.id ?? item.label} data-description={item.description} disabled={item.isDisabled} onClick={item.onClick}>
        {item.label}
      </button>
    );
    return (
      <menu>
        {items.map((item, i) =>
          item.type === "divider" ? (
            <hr key={`divider-${i}`} />
          ) : item.type === "section" ? (
            <section key={item.id} aria-label={item.title}>
              {item.title && <h2>{item.title}</h2>}
              {item.items!.map(row)}
            </section>
          ) : (
            row(item)
          ),
        )}
      </menu>
    );
  },
}));

const { bookmarkHost, openableOrigin, survivesSwitch, WorkspaceSwitcher } = await import("./WorkspaceSwitcher");
const { setAuthConfigForTest } = await import("../lib/session/auth-config");

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

describe("survivesSwitch", () => {
  it("keeps every settings section, nested ones included", () => {
    expect(survivesSwitch("/settings")).toBe(true);
    expect(survivesSwitch("/settings/profile")).toBe(true);
    expect(survivesSwitch("/settings/appearance")).toBe(true);
    expect(survivesSwitch("/settings/workspace")).toBe(true);
    expect(survivesSwitch("/settings/workspace/members")).toBe(true);
    expect(survivesSwitch("/settings/workspace/audit")).toBe(true);
    expect(survivesSwitch("/settings/node/storage")).toBe(true);
  });

  it("keeps Agents", () => {
    expect(survivesSwitch("/settings/agents")).toBe(true);
  });

  it("sends tenant-scoped paths back to the library", () => {
    expect(survivesSwitch("/")).toBe(false);
    expect(survivesSwitch("/doc/abc")).toBe(false);
    expect(survivesSwitch("/ask/thread-1")).toBe(false);
    expect(survivesSwitch("/join/some-token")).toBe(false);
  });

  it("does not match a prefix that only starts with the same letters", () => {
    expect(survivesSwitch("/settingsfoo")).toBe(false);
    expect(survivesSwitch("/settings-export")).toBe(false);
    expect(survivesSwitch("/agentsmith")).toBe(false);
  });
});

describe("openableOrigin", () => {
  it("keeps a web address's origin", () => {
    expect(openableOrigin("https://studio.example")).toBe("https://studio.example");
    expect(openableOrigin("http://nas.local:8787")).toBe("http://nas.local:8787");
    expect(openableOrigin("https://studio.example/doc/1?x=1")).toBe("https://studio.example");
  });

  it("refuses anything that would not load a web page, and never throws", () => {
    for (const origin of ["javascript:alert(document.cookie)", "JavaScript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "ftp://files.example", "studio.example", "", "http://"]) {
      expect(openableOrigin(origin), origin).toBeNull();
    }
  });
});

describe("bookmarkHost", () => {
  it("has nothing to show for an address that is not one, instead of throwing", () => {
    expect(bookmarkHost({ id: "nb_9", label: "Broken", origin: "not a url" })).toBeUndefined();
    expect(bookmarkHost({ id: "nb_9", label: "Script", origin: "javascript:alert(1)" })).toBeUndefined();
    expect(bookmarkHost({ id: "nb_9", label: "Studio", origin: "https://studio.example" })).toBe("studio.example");
  });
});

describe("the switcher's menu", () => {
  const STUDIO: OtherNode = { id: "nb_1", label: "Studio", origin: "https://studio.example" };
  const NAS: OtherNode = { id: "nb_2", label: "nas.local:8787", origin: "http://nas.local:8787" };
  const originalLocation = window.location;
  const assign = vi.fn();
  let host: HTMLDivElement;
  let root: Root;
  let changed: () => void;

  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("menu button")];
  const button = (label: string) => buttons().find((b) => b.textContent === label);
  const section = (title: string) => host.querySelector(`section[aria-label="${title}"]`);

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    setAuthConfigForTest({ nodeName: "Liv’s Mac", nodeLabel: "Liv’s Mac" });
    workspaces.list.mockResolvedValue({
      workspaces: [
        { workspace_id: "ws1", name: "Acme", role: "owner" },
        { workspace_id: "ws2", name: "Side project", role: "member" },
      ],
      active: "ws1",
    });
    otherNodes.list.mockResolvedValue({ current: { name: "Liv’s Mac", origin: "http://localhost:8787" }, nodes: [STUDIO, NAS] });
    otherNodes.onChanged.mockImplementation((fn: () => void) => {
      changed = fn;
      return () => {};
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<WorkspaceSwitcher />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    setAuthConfigForTest(null);
    vi.clearAllMocks();
  });

  it("is headed by the node's name over its workspaces, with Other nodes below Create workspace", () => {
    expect([...host.querySelectorAll("menu h2")].map((h) => h.textContent)).toEqual(["Liv’s Mac", "Other nodes"]);
    expect([...section("Liv’s Mac")!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Acme", "Side project"]);
    expect([...section("Other nodes")!.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Studio",
      "nas.local:8787",
      "Add or remove nodes…",
    ]);
    expect(buttons().map((b) => b.textContent).indexOf("Create workspace")).toBe(2);
  });

  it("names no node while the person keeps no other: no headings, and adding one sits beside Create workspace", async () => {
    otherNodes.list.mockResolvedValue({ current: { name: "Liv’s Mac", origin: "http://localhost:8787" }, nodes: [] });
    await act(async () => changed());

    expect(host.querySelectorAll("menu h2")).toHaveLength(0);
    expect(buttons().map((b) => b.textContent)).toEqual(["Acme", "Side project", "Create workspace", "Add another node…"]);
    // One group of actions: no divider between the two.
    expect(menu.items.slice(-2).map((i) => i.id)).toEqual(["create", "add-node"]);

    await act(async () => button("Add another node…")!.click());
    expect(document.querySelector("dialog[open]")?.textContent).toContain("Other nodes");
  });

  it("gains both headings with the first node kept", async () => {
    otherNodes.list.mockResolvedValue({ current: { name: "Liv’s Mac", origin: "http://localhost:8787" }, nodes: [] });
    await act(async () => changed());
    otherNodes.list.mockResolvedValue({ current: { name: "Liv’s Mac", origin: "http://localhost:8787" }, nodes: [STUDIO] });
    await act(async () => changed());

    expect([...host.querySelectorAll("menu h2")].map((h) => h.textContent)).toEqual(["Liv’s Mac", "Other nodes"]);
    expect(button("Add another node…")).toBeUndefined();
    expect(button("Add or remove nodes…")).toBeDefined();
  });

  it("heads an unnamed node's workspaces by its host label, not by the product's name the brand slot shows", async () => {
    await act(async () => root.unmount());
    setAuthConfigForTest({ nodeName: null, nodeLabel: "livs-air" });
    root = createRoot(host);
    await act(async () => root.render(<WorkspaceSwitcher />));
    expect([...host.querySelectorAll("menu h2")].map((h) => h.textContent)).toEqual(["livs-air", "Other nodes"]);
  });

  it("shows a bookmark's host under a label that is not already the host", () => {
    expect(button("Studio")!.dataset.description).toBe("studio.example");
    expect(button("nas.local:8787")!.dataset.description).toBeUndefined();
  });

  it("opens a bookmark by navigating the whole page to its origin", async () => {
    await act(async () => button("Studio")!.click());
    expect(assign).toHaveBeenCalledWith("https://studio.example");
  });

  it("still renders beside a bookmark that is not a web address, and never navigates to one", async () => {
    otherNodes.list.mockResolvedValue({
      current: { name: "Liv’s Mac", origin: "http://localhost:8787" },
      nodes: [STUDIO, { id: "nb_3", label: "Script", origin: "javascript:alert(document.cookie)" }, { id: "nb_4", label: "Broken", origin: "not a url" }],
    });
    await act(async () => changed());

    expect([...section("Other nodes")!.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Studio",
      "Script",
      "Broken",
      "Add or remove nodes…",
    ]);
    for (const label of ["Script", "Broken"]) {
      expect(button(label)!.disabled).toBe(true);
      expect(button(label)!.dataset.description).toBeUndefined();
      // Past the disabled row too: the handler itself refuses.
      const row = menu.items.find((i) => i.id === "other-nodes")!.items!.find((i) => i.label === label)!;
      await act(async () => row.onClick!());
    }
    expect(assign).not.toHaveBeenCalled();
    expect(button("Studio")!.disabled).toBe(false);
  });

  it("re-reads the bookmarks when the list changes", async () => {
    otherNodes.list.mockResolvedValue({ current: { name: "Liv’s Mac", origin: "http://localhost:8787" }, nodes: [NAS] });
    await act(async () => changed());
    expect([...section("Other nodes")!.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "nas.local:8787",
      "Add or remove nodes…",
    ]);
  });

  it("opens the dialog that lists the bookmarks", async () => {
    await act(async () => button("Add or remove nodes…")!.click());
    const dialog = document.querySelector("dialog[open]");
    expect(dialog?.textContent).toContain("Other nodes");
    expect(dialog?.textContent).toContain("https://studio.example");
  });
});
