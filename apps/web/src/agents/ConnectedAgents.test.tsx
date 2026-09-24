// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentKeyInfo } from "../api";

const keys = vi.hoisted(() => ({ mine: vi.fn(), rename: vi.fn(), rotate: vi.fn(), revoke: vi.fn() }));
const toasts = vi.hoisted(() => ({ shown: [] as string[] }));

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), AgentKeys: keys }));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string }) => toasts.shown.push(t.body),
}));

const { ConnectedAgents } = await import("./ConnectedAgents");

/** Two connections of one client: the case the name field used to try to prevent at minting. */
const KEY = (keyId: string): AgentKeyInfo =>
  ({
    key_id: keyId,
    agent_id: `agent-${keyId}`,
    name: "Claude Code",
    kind: "key",
    workspace_id: "ws1",
    created_at: "2026-09-01T10:00:00Z",
    last_used_at: null,
    revoked_at: null,
    access: "propose",
    scope_folders: null,
    expires_at: null,
  }) as unknown as AgentKeyInfo;

let container: HTMLDivElement;
let root: Root;

const text = () => document.body.textContent ?? "";
const buttons = (re: RegExp) => [...document.querySelectorAll("button")].filter((b) => re.test(b.textContent ?? ""));
const click = (el: Element | undefined) => {
  expect(el).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

function type(value: string): void {
  const input = document.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  await act(async () =>
    root.render(<ConnectedAgents activeWorkspaceId="ws1" workspaces={[]} reloadSignal={0} />),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  toasts.shown = [];
  keys.mine.mockResolvedValue({ keys: [KEY("k1"), KEY("k2")] });
  await mount();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectedAgents — how a connection was granted", () => {
  it("says which way each key was granted, in words rather than a badge", async () => {
    keys.mine.mockResolvedValue({
      keys: [KEY("k1"), { ...KEY("k2"), kind: "connector", name: "Claude" }],
    });
    act(() => root.unmount());
    container.remove();
    await mount();
    expect(text()).toContain("key created");
    expect(text()).toContain("signed in");
    // "Connector" is Claude's word for its own connections; Codex and Antigravity arrive the same way.
    expect(text()).not.toContain("Connector");
  });

  it("offers Rotate only where a new token has somewhere to go", async () => {
    keys.mine.mockResolvedValue({ keys: [{ ...KEY("k1"), kind: "connector" }] });
    act(() => root.unmount());
    container.remove();
    await mount();
    expect(buttons(/Rotate/)).toHaveLength(0);
    expect(buttons(/Revoke/)).toHaveLength(1);
    expect(buttons(/Rename/)).toHaveLength(1);
  });
});

describe("ConnectedAgents — renaming", () => {
  it("renames the one row, which is how two connections of one client are told apart", async () => {
    keys.rename.mockResolvedValue({});
    keys.mine.mockResolvedValue({ keys: [{ ...KEY("k1"), name: "Claude Code (laptop)" }, KEY("k2")] });
    click(buttons(/Rename/)[0]);
    type("Claude Code (laptop)");
    await act(async () => {
      buttons(/Save/)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(keys.rename).toHaveBeenCalledWith("k1", "Claude Code (laptop)");
    expect(text()).toContain("Claude Code (laptop)");
  });

  it("asks the node nothing when the name is unchanged or blank", async () => {
    click(buttons(/Rename/)[0]);
    type("   ");
    await act(async () => {
      buttons(/Save/)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(keys.rename).not.toHaveBeenCalled();
    expect(buttons(/Save/)).toHaveLength(0);
  });

  it("keeps the old name and says so when the node refuses", async () => {
    keys.rename.mockRejectedValue(new Error("name cannot be empty"));
    click(buttons(/Rename/)[0]);
    type("Other");
    await act(async () => {
      buttons(/Save/)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // errorMessage prefers the node's own sentence over the fallback.
    expect(toasts.shown).toEqual(["name cannot be empty"]);
    expect(text()).toContain("Claude Code");
  });
});
