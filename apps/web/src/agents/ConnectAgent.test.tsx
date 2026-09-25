// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentSetup } from "@stuga/protocol/api/agent-setup";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const keys = vi.hoisted(() => ({ create: vi.fn() }));
const agents = vi.hoisted(() => ({ setup: vi.fn(), bundle: vi.fn() }));
const toasts = vi.hoisted(() => ({ shown: [] as string[] }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  AgentKeys: keys,
  Agents: agents,
}));

vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string }) => toasts.shown.push(t.body),
}));

const { ConnectAgent } = await import("./ConnectAgent");

const URL_ = "https://stuga.team.example.com/mcp";
const PAGE_MCP = `${location.origin}/mcp`;
const ENTRY = "/srv/stuga/services/mcp/dist/stuga-mcp.js";

/** A node on a public address. */
const REACHABLE: AgentSetup = {
  url: "https://stuga.team.example.com",
  mcp_url: URL_,
  node: { id: "mzxw6ytboi4dqnrq", name: "Team" },
  reachable: true,
  loopback: false,
  secure: true,
  bundle: { available: true },
  stdio: { command: "/usr/local/bin/node", entry: ENTRY },
};

/** A node on localhost, whose paths this machine can open. */
const LOCAL: AgentSetup = {
  ...REACHABLE,
  url: "http://localhost:8787",
  mcp_url: "http://localhost:8787/mcp",
  node: { id: "ktbbpahhzxoldakw", name: "Liv’s Mac" },
  reachable: false,
  loopback: true,
};

/** A localhost node that names no server file. */
const NO_LOCAL_ENTRY: AgentSetup = { ...LOCAL, stdio: { ...LOCAL.stdio, entry: null } };

/** A node on the LAN, whose files are not on the browser's machine and whose address is not https. */
const LAN: AgentSetup = {
  ...REACHABLE,
  url: "http://192.168.1.50:8787",
  mcp_url: "http://192.168.1.50:8787/mcp",
  reachable: false,
  secure: false,
};

// jsdom implements no object URLs; recorded, since a URL never revoked pins the file in memory.
const objectUrls = { created: [] as Blob[], revoked: [] as string[] };
URL.createObjectURL = ((blob: Blob) => {
  objectUrls.created.push(blob);
  return `blob:stuga/${objectUrls.created.length}`;
}) as typeof URL.createObjectURL;
URL.revokeObjectURL = ((url: string) => {
  objectUrls.revoked.push(url);
}) as typeof URL.revokeObjectURL;

let container: HTMLDivElement;
let root: Root;

const text = () => document.body.textContent ?? "";
/** Astryx tabs are buttons carrying `data-tab-value`. */
function clickTab(value: string): void {
  const el = document.querySelector(`[data-tab-value="${value}"]`);
  expect(el, `no tab for ${value}`).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Astryx TextInput keeps its value in React state; drive it through the DOM. */
function type(labelText: string, value: string): void {
  const input = [...document.querySelectorAll("input")].find(
    (i) => (document.querySelector(`label[for="${i.id}"]`)?.textContent ?? "").includes(labelText),
  );
  expect(input, `no input labelled ${labelText}`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (re: RegExp) =>
  [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));

/** A Link renders as an anchor or a button, depending on its href. */
const link = (re: RegExp) =>
  [...document.querySelectorAll("a, button")].find((el) => re.test(el.textContent ?? ""));

/** Mount against the node's answer, or a failed request for null. */
async function mount(setup: AgentSetup | null, props: Partial<Parameters<typeof ConnectAgent>[0]> = {}) {
  if (root) {
    act(() => root.unmount());
    container.remove();
  }
  agents.setup.mockImplementation(() =>
    setup ? Promise.resolve(setup) : Promise.reject(new Error("unreachable")),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  await act(async () => root.render(<ConnectAgent onKeyCreated={() => {}} {...props} />));
}

beforeEach(async () => {
  vi.clearAllMocks();
  toasts.shown = [];
  objectUrls.created = [];
  objectUrls.revoked = [];
  root = undefined as unknown as Root;
  await mount(REACHABLE);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectAgent", () => {
  it("shows the whole endpoint, not a clipped prefix", () => {
    expect(text()).toContain(URL_);
    expect(text()).not.toContain("…");
  });

  it("gives Claude Code a complete command and no token to hunt for", () => {
    clickTab("claude-code");
    expect(text()).toContain(`claude mcp add -s user --transport http stuga ${URL_}`);
    expect(text()).toContain("choose stuga, then Authenticate in your browser");
    expect(text()).not.toContain("Authorization: Bearer");
    expect(keys.create).not.toHaveBeenCalled();
  });

  it("gives Claude Code a key where its browser sign-in cannot work", async () => {
    keys.create.mockResolvedValue({ name: "Claude Code", token: "vk_live_cc" });
    await mount(LAN);
    clickTab("claude-code");
    // Nothing to sign in to: the command is complete once the key is in it.
    expect(text()).not.toContain("Authenticate in your browser");
    expect(text()).toContain("needs an https node");
    expect(text()).toContain(
      'claude mcp add -s user --transport http stuga http://192.168.1.50:8787/mcp --header "Authorization: Bearer vk_your_key_here"',
    );
    await act(async () => {
      button(/Create key/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Named for the client without anyone typing it, and pasted straight into the command.
    expect(keys.create).toHaveBeenCalledWith("Claude Code", {});
    expect(text()).toContain('--header "Authorization: Bearer vk_live_cc"');
    expect(text()).not.toContain("vk_your_key_here");
  });

  it.each([
    ["codex", "Codex"],
    ["antigravity", "Antigravity"],
  ])("gives %s one setup command and never a key", (tab, host) => {
    clickTab(tab);
    expect(text()).toContain(`curl -fsSL 'https://stuga.team.example.com/api/agent-install/${tab}' | sh`);
    expect(text()).toContain(
      tab === "codex" ? "Installs Stuga and opens browser sign-in" : "Settings → Customizations → Installed MCP Servers",
    );
    expect(text()).toContain(`Restart ${host}`);
    expect(text()).not.toContain("can you access my Stuga workspace?");
    // Nothing on the page mints, shows or asks for a key: the sign-in grants the access.
    expect(text()).not.toContain("?key=");
    expect(text()).not.toContain("vk_your_key_here");
    expect(keys.create).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", "Codex"],
    ["antigravity", "Antigravity"],
  ])("keeps complete %s uninstall guidance collapsed until requested", (tab, host) => {
    clickTab(tab);
    // The guide stays mounted while collapsed, so the code blocks do not rebuild when it opens.
    const trigger = link(new RegExp(`^Uninstall from ${host}$`))!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Local removal does not revoke access");
    expect(text()).toContain("Disconnect this node");
    expect(text()).toContain(`curl -fsSL 'https://stuga.team.example.com/api/agent-install/${tab}?action=disconnect' | sh`);
    expect(text()).toContain("Remove Stuga completely");
    expect(text()).toContain(`curl -fsSL 'https://stuga.team.example.com/api/agent-install/${tab}?action=uninstall' | sh`);
    expect(text()).toContain("only for your last Stuga node");
    expect(text()).toContain("revoke the connection");
    expect(link(/revoke the connection/)?.getAttribute("href")).toBe("#connected-agents");
  });

  it("takes Claude Code's connection away again, and says a local removal is not a revocation", () => {
    clickTab("claude-code");
    const trigger = link(/^Uninstall from Claude Code$/)!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).toContain("claude mcp remove -s user stuga");
    expect(text()).toContain("Local removal does not revoke access");
    expect(link(/revoke the connection/)?.getAttribute("href")).toBe("#connected-agents");
  });

  it("takes Claude Desktop's connection away again, by whichever path set it up", async () => {
    await mount(LOCAL);
    const trigger = link(/^Uninstall from Claude Desktop$/)!;
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).toContain("Settings → Extensions");
    expect(text()).toContain("delete its stuga entry");
    expect(text()).toContain("Local removal does not revoke access");
    expect(link(/revoke the connection/)?.getAttribute("href")).toBe("#connected-agents");
  });

  it("gives other clients a config with the endpoint and a bearer slot", () => {
    clickTab("other");
    expect(text()).toContain(`"url": "${URL_}"`);
    expect(text()).toContain("Bearer vk_your_key_here");
  });

  it("mints the key beside the config and writes it into the config", async () => {
    keys.create.mockResolvedValue({ name: "my-agent", token: "vk_live_abc123" });
    clickTab("other");
    expect([...document.querySelectorAll("input")].some((i) => i.placeholder === "my-agent")).toBe(true);
    type("Agent name", "my-agent");
    await act(async () => {
      button(/Create key/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(keys.create).toHaveBeenCalledWith("my-agent", {});
    expect(text()).toContain('"Authorization": "Bearer vk_live_abc123"');
    expect(text()).not.toContain("vk_your_key_here");
    expect(text()).toContain("Shown once. Treat it like a password.");
  });

  it("says a read-only key can read and search but not change anything, and mints one", async () => {
    keys.create.mockResolvedValue({ name: "scout", token: "vk_live_ro" });
    clickTab("other");
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent === "Access");
    expect(label, "no Access selector").toBeTruthy();
    const trigger = document.getElementById(label!.getAttribute("for")!)!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const readOnly = [...listbox.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith("Read only"));
    expect(readOnly?.textContent).toContain("Can read and search, but not make changes.");
    await act(async () => {
      readOnly!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    type("Agent name", "scout");
    await act(async () => {
      button(/Create key/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(keys.create).toHaveBeenCalledWith("scout", { access: "read" });
  });

  it("tells the page a key appeared, so the list below refreshes", async () => {
    keys.create.mockResolvedValue({ name: "another", token: "vk_live_zzz" });
    const onKeyCreated = vi.fn();
    await mount(REACHABLE, { onKeyCreated });
    clickTab("other");
    type("Agent name", "another");
    await act(async () => {
      button(/Create key/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onKeyCreated).toHaveBeenCalledTimes(1);
  });

  it("keeps the failed mint's message and leaves the placeholder alone", async () => {
    keys.create.mockRejectedValue(new Error("Free workspaces get one key"));
    clickTab("other");
    type("Agent name", "nope");
    await act(async () => {
      button(/Create key/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toasts.shown).toContain("Free workspaces get one key");
    expect(text()).toContain("Bearer vk_your_key_here");
  });
  it("leads with the connector when this node can be dialled from outside", () => {
    expect(document.querySelector('[data-tab-value="claude-desktop"]')).toBeTruthy();
    expect(text()).toContain("Add custom connector");
    expect(text()).toContain(URL_);
  });

  it("builds every config from the node's own address, not the page's", async () => {
    await mount(LOCAL);
    clickTab("claude-code");
    expect(text()).toContain("claude mcp add -s user --transport http stuga http://localhost:8787/mcp");
    clickTab("other");
    expect(text()).toContain('"url": "http://localhost:8787/mcp"');
    clickTab("codex");
    expect(text()).toContain("curl -fsSL 'http://localhost:8787/api/agent-install/codex' | sh");
    expect(text()).not.toContain(PAGE_MCP);
  });

  it("leads with Claude Desktop when nothing outside this machine can reach the node", async () => {
    await mount(LOCAL);
    expect(text()).toContain("Settings → Developer");
    expect(text()).toContain("fully restart Claude");
  });

  it("does not offer a connector this node cannot answer", async () => {
    await mount(LOCAL);
    expect(document.querySelector('[data-tab-value="claude"]')).toBeNull();
    expect(text()).not.toContain("Add custom connector");
  });

  it("keeps the connector where a node can actually be dialled", async () => {
    await mount(REACHABLE);
    expect(document.querySelector('[data-tab-value="claude"]')).toBeTruthy();
    clickTab("claude");
    expect(text()).toContain("Add custom connector");
  });

  it("gives Claude Desktop this node's own interpreter and entry point", async () => {
    await mount(LOCAL);
    expect(text()).toContain('"stuga": {');
    expect(text()).toContain('"command": "/usr/local/bin/node"');
    expect(text()).toContain(`"${ENTRY}"`);
    expect(text()).toContain('"STUGA_URL": "http://localhost:8787"');
    expect(text()).toContain('"STUGA_CLIENT": "claude-desktop"');
  });

  it("offers no hand-written config when packaging names no local path, however local the address", async () => {
    await mount(NO_LOCAL_ENTRY);
    expect(text()).not.toContain('"command"');
    expect(link(/Set it up by hand instead/)).toBeUndefined();
    expect(document.querySelector('[data-testid="manual-setup"]')).toBeNull();
    expect(button(/Add to Claude Desktop/)).toBeTruthy();
  });

  it("keeps a node across the network's paths out of the client's hands", async () => {
    await mount(LAN);
    expect(text()).not.toContain("/usr/local/bin/node");
    expect(text()).not.toContain(ENTRY);
    expect(link(/Set it up by hand instead/)).toBeUndefined();
    expect(button(/Add to Claude Desktop/)).toBeTruthy();
  });

  it("mints the desktop key under the client's own name, into the desktop config, in one copy", async () => {
    keys.create.mockResolvedValue({ name: "Claude Desktop", token: "vk_live_desk" });
    await mount(LOCAL);
    // A tab that knows its client asks for no name: Connected agents renames a second one.
    expect(text()).not.toContain("Agent name");
    await act(async () => {
      button(/Create key/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(keys.create).toHaveBeenCalledWith("Claude Desktop", {});
    expect(text()).toContain('"STUGA_TOKEN": "vk_live_desk"');
    expect(text()).not.toContain("vk_your_key_here");
  });

  it("offers the extension first", async () => {
    await mount(LOCAL);
    expect(button(/Add to Claude Desktop/)).toBeTruthy();
    expect(text()).toContain("Open stuga.mcpb");
  });

  it("saves the file and admits it saved it, with no key to create or warn about", async () => {
    const file = new Blob(["PK"], { type: "application/octet-stream" });
    agents.bundle.mockResolvedValue(file);
    const onKeyCreated = vi.fn();
    await mount(LOCAL, { onKeyCreated });
    await act(async () => {
      button(/Add to Claude Desktop/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(agents.bundle).toHaveBeenCalledTimes(1);
    expect(objectUrls.created).toEqual([file]);
    expect(objectUrls.revoked).toEqual(["blob:stuga/1"]);
    expect(text()).toContain("install it, then restart Claude");
    expect(toasts.shown).toContain("stuga.mcpb saved. Double-click it to install.");
    expect(text()).toContain("stuga.mcpb saved — install it, then restart Claude");
    expect(text()).toContain("approve Stuga in your browser");
    expect(text()).not.toContain("carries a working key");
    expect(onKeyCreated).not.toHaveBeenCalled();
  });

  it("keeps the failed download's message and offers the button again", async () => {
    agents.bundle.mockRejectedValue(new Error("The server ran out of disk"));
    await mount(LOCAL);
    await act(async () => {
      button(/Add to Claude Desktop/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toasts.shown).toContain("The server ran out of disk");
    expect(objectUrls.created).toEqual([]);
    expect(text()).not.toContain("install it, then restart Claude");
    expect(button(/Add to Claude Desktop/)).toBeTruthy();
  });

  it("keeps the hand-written config underneath the one-click path, not instead of it", async () => {
    await mount(LOCAL);
    const toggle = link(/Set it up by hand instead/);
    expect(toggle).toBeTruthy();
    const manual = document.querySelector('[data-testid="manual-setup"]');
    expect(manual!.hasAttribute("hidden")).toBe(true);
    expect(text()).toContain('"command": "/usr/local/bin/node"');
    expect(text()).toContain("Settings → Developer");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="manual-setup"]')!.hasAttribute("hidden")).toBe(false);
  });

  it("says a development run has no extension, without sending anyone to build a copy of Stuga", async () => {
    await mount({ ...NO_LOCAL_ENTRY, bundle: { available: false } });
    expect(button(/Add to Claude Desktop/)).toBeUndefined();
    expect(text()).toContain("development run");
    expect(text()).not.toContain('"command"');
  });

  it("opens the hand-written config by itself when it is the only path", async () => {
    await mount({ ...LOCAL, bundle: { available: false } });
    expect(button(/Add to Claude Desktop/)).toBeUndefined();
    expect(document.querySelector('[data-testid="manual-setup"]')!.hasAttribute("hidden")).toBe(false);
    expect(link(/Set it up by hand instead/)).toBeUndefined();
    expect(text()).toContain(`"${ENTRY}"`);
  });

  it("offers a retry instead of guessing an endpoint when the node's setup cannot be read", async () => {
    await mount(null);
    expect(text()).toContain("Couldn’t load connection options");
    expect(text()).not.toContain(PAGE_MCP);
    expect(document.querySelector("[data-tab-value]")).toBeNull();
    agents.setup.mockResolvedValue(REACHABLE);
    await act(async () => {
      button(/Retry/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).toContain(URL_);
  });
});

describe("ConnectAgent — DeepSeek Harness tab", () => {
  it("prints the install command and an environment block with a bearer slot", () => {
    clickTab("dsh");
    expect(text()).toContain("dsh plugin --profile web add @stuga/dsh-plugin");
    // The product's name in prose; `dsh` only where it is the command being run.
    expect(text().replace("dsh plugin --profile web add @stuga/dsh-plugin", "")).not.toContain("dsh");
    expect(text()).toContain("STUGA_URL=");
    expect(text()).toContain("STUGA_API_KEY=vk_your_key_here");
  });

  it("mints the key beside the steps and writes it into the environment block", async () => {
    keys.create.mockResolvedValue({ name: "DeepSeek Harness", token: "vk_live_dsh" });
    clickTab("dsh");
    expect(text()).not.toContain("Agent name");
    await act(async () => {
      button(/Create key/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(keys.create).toHaveBeenCalledWith("DeepSeek Harness", {});
    expect(text()).toContain("STUGA_API_KEY=vk_live_dsh");
    expect(text()).not.toContain("vk_your_key_here");
  });
});
