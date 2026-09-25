// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentKeyInfo, ConnectionInfo } from "../api";

const keys = vi.hoisted(() => ({ mine: vi.fn(), rename: vi.fn(), rotate: vi.fn(), revoke: vi.fn() }));
const connections = vi.hoisted(() => ({ mine: vi.fn(), rename: vi.fn(), revoke: vi.fn() }));
const toasts = vi.hoisted(() => ({ shown: [] as string[] }));

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), AgentKeys: keys, Connections: connections }));
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

/** An app that signed in. */
const SIGN_IN = (grantId: string, over: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  grant_id: grantId,
  agent_id: `agent-conn-${grantId}`,
  name: "Claude",
  client_id: "https://claude.ai/oauth/mcp-client-metadata",
  verified_host: "claude.ai",
  workspaces: ["ws1"],
  access: "propose",
  created_at: "2026-09-01T10:00:00Z",
  last_used_at: null,
  revoked_at: null,
  ...over,
});

const WORKSPACES = [
  { workspace_id: "ws1", name: "Studio", role: "owner" },
  { workspace_id: "ws2", name: "Family", role: "member" },
] as never;

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
    root.render(<ConnectedAgents activeWorkspaceId="ws1" workspaces={WORKSPACES} reloadSignal={0} />),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  toasts.shown = [];
  keys.mine.mockResolvedValue({ keys: [KEY("k1"), KEY("k2")] });
  connections.mine.mockResolvedValue({ connections: [] });
  await mount();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectedAgents — how a connection was granted", () => {
  async function remount() {
    act(() => root.unmount());
    container.remove();
    await mount();
  }

  it("lists apps that signed in beside keys, saying which way each was granted in words rather than a badge", async () => {
    keys.mine.mockResolvedValue({ keys: [KEY("k1")] });
    connections.mine.mockResolvedValue({ connections: [SIGN_IN("g1")] });
    await remount();
    expect(text()).toContain("key created");
    expect(text()).toContain("signed in");
    expect(text()).toContain("verified by claude.ai");
    // "Connector" is Claude's word for its own connections; Codex and Antigravity arrive the same way.
    expect(text()).not.toContain("Connector");
  });

  it("leaves out the connector keys sign-ins used to mint", async () => {
    keys.mine.mockResolvedValue({ keys: [{ ...KEY("k9"), kind: "connector", name: "Old sign-in", revoked_at: "2026-09-25T00:00:00Z" }] });
    await remount();
    expect(text()).not.toContain("Old sign-in");
  });

  it("offers Rotate only where a new token has somewhere to go", async () => {
    keys.mine.mockResolvedValue({ keys: [] });
    connections.mine.mockResolvedValue({ connections: [SIGN_IN("g1")] });
    await remount();
    expect(buttons(/Rotate/)).toHaveLength(0);
    expect(buttons(/Revoke/)).toHaveLength(1);
    expect(buttons(/Rename/)).toHaveLength(1);
  });

  it("badges a sign-in that reaches fewer workspaces than its person has, or only reads", async () => {
    keys.mine.mockResolvedValue({ keys: [] });
    connections.mine.mockResolvedValue({ connections: [SIGN_IN("g1"), SIGN_IN("g2", { name: "Codex", workspaces: ["ws1", "ws2"], access: "read" })] });
    await remount();
    // One of the person's two workspaces is named; one that reaches both says nothing about where.
    expect(text()).toContain("Studio");
    expect(text()).not.toContain("2 workspaces");
    expect(text()).toContain("Read-only");
  });

  it("revokes a sign-in through its connection, and a key through the key", async () => {
    keys.mine.mockResolvedValue({ keys: [] });
    connections.mine.mockResolvedValue({ connections: [SIGN_IN("g1")] });
    connections.revoke.mockResolvedValue({ revoked: true });
    await remount();
    click(buttons(/^Revoke$/)[0]);
    await act(async () => {
      buttons(/Confirm revoke/)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(connections.revoke).toHaveBeenCalledWith("g1");
    expect(keys.revoke).not.toHaveBeenCalled();
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
