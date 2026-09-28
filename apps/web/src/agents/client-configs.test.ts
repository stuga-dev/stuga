import { describe, expect, it } from "vitest";
import type { AgentSetup } from "@stuga/protocol/api/agent-setup";
import { CLIENT_GROUPS, TAB_LABEL, clientConfigs, clientTabs, TOKEN_PLACEHOLDER } from "./client-configs";

const PUBLIC: AgentSetup = {
  url: "https://stuga.example.com",
  mcp_url: "https://stuga.example.com/mcp",
  node: { id: "mzxw6ytboi4dqnrq", name: "Studio" },
  reachable: true,
  loopback: false,
  secure: true,
  bundle: { available: true },
  stdio: { command: "/usr/local/bin/node", entry: "/srv/stuga/mcp/index.js" },
};
const LOCAL: AgentSetup = {
  ...PUBLIC,
  url: "http://localhost:8787",
  mcp_url: "http://localhost:8787/mcp",
  node: { id: "ktbbpahhzxoldakw", name: "Liv’s Mac" },
  reachable: false,
  loopback: true,
};

/** A node on the network at a plain-http address: no https, no loopback. */
const LAN: AgentSetup = {
  ...PUBLIC,
  url: "http://192.168.1.50:8787",
  mcp_url: "http://192.168.1.50:8787/mcp",
  reachable: false,
  secure: false,
};

/** The one server entry a JSON config holds, under its key. */
const servers = (json: string) => JSON.parse(json).mcpServers as Record<string, Record<string, unknown> & { env: Record<string, string> }>;

describe("clientTabs", () => {
  it("offers the hosted connector only on a node the internet can reach", () => {
    expect(clientTabs(PUBLIC)[0]).toBe("claude");
    expect(clientTabs(PUBLIC)).toEqual([
      "claude",
      "claude-desktop",
      "lmstudio",
      "cursor",
      "vscode",
      "antigravity",
      "kiro",
      "claude-code",
      "codex",
      "goose",
      "pi",
      "dsh",
      "other",
    ]);
    expect(clientTabs(LOCAL)).not.toContain("claude");
    expect(clientTabs(LOCAL)[0]).toBe("claude-desktop");
    expect(clientTabs(LOCAL).at(-1)).toBe("other");
  });

  it("lists every client in exactly one group, with Other clients last on its own", () => {
    const grouped = CLIENT_GROUPS.flatMap((g) => g.clients);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped, "other"].sort()).toEqual(Object.keys(TAB_LABEL).sort());
  });
});

describe("install links", () => {
  const decode64 = (link: string) => JSON.parse(atob(new URL(link).searchParams.get("config")!));

  it("open each app with this node's endpoint and no key", () => {
    const { links } = clientConfigs(LAN, "vk_live");
    const endpoint = "http://192.168.1.50:8787/mcp";
    expect(links.cursor.signIn.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=stuga&config=")).toBe(true);
    expect(decode64(links.cursor.signIn)).toEqual({ url: endpoint });
    expect(links.lmstudio.signIn.startsWith("lmstudio://add_mcp?name=stuga&config=")).toBe(true);
    expect(decode64(links.lmstudio.signIn)).toEqual({ url: endpoint });
    expect(JSON.parse(decodeURIComponent(links.vscode.signIn.slice("vscode:mcp/install?".length)))).toEqual({
      name: "stuga",
      type: "http",
      url: endpoint,
    });
    expect(JSON.parse(new URL(links.kiro.signIn).searchParams.get("config")!)).toEqual({ url: endpoint, disabled: false, autoApprove: [] });
    const goose = new URL(links.goose.signIn);
    expect(goose.protocol).toBe("goose:");
    expect(goose.searchParams.get("url")).toBe(endpoint);
    expect(goose.searchParams.get("type")).toBe("streamable_http");
    for (const link of Object.values(links)) expect(link.signIn).not.toContain("vk_live");
  });

  it("carry a minted key only in the key form, and Goose has none", () => {
    const { links } = clientConfigs(PUBLIC, "vk_live");
    const bearer = { Authorization: "Bearer vk_live" };
    expect(decode64(links.cursor.withKey!).headers).toEqual(bearer);
    expect(decode64(links.lmstudio.withKey!).headers).toEqual(bearer);
    expect(JSON.parse(decodeURIComponent(links.vscode.withKey!.slice("vscode:mcp/install?".length))).headers).toEqual(bearer);
    expect(JSON.parse(new URL(links.kiro.withKey!).searchParams.get("config")!).headers).toEqual(bearer);
    expect(links.goose.withKey).toBeNull();
  });
});

describe("clientConfigs", () => {
  it("has Claude Code sign in where that works, and carry a key where it cannot", () => {
    for (const secure of [PUBLIC, LOCAL]) {
      const c = clientConfigs(secure, "vk_live");
      expect(c.cliNeedsKey).toBe(false);
      expect(c.cliCommand).not.toContain("vk_live");
    }
    const lan = clientConfigs(LAN, null);
    expect(lan.cliNeedsKey).toBe(true);
    expect(lan.cliCommand).toBe(
      `claude mcp add -s user --transport http stuga http://192.168.1.50:8787/mcp --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`,
    );
    expect(clientConfigs(LAN, "vk_live").cliCommand).toContain('--header "Authorization: Bearer vk_live"');
  });

  it("names the node's own origin in every config", () => {
    const c = clientConfigs(LOCAL, null);
    expect(c.cliCommand).toBe("claude mcp add -s user --transport http stuga http://localhost:8787/mcp");
    expect(c.installers.codex).toEqual({
      setup: "curl -fsSL 'http://localhost:8787/api/agent-install/codex' | sh",
      disconnect: "curl -fsSL 'http://localhost:8787/api/agent-install/codex?action=disconnect' | sh",
      uninstall: "curl -fsSL 'http://localhost:8787/api/agent-install/codex?action=uninstall' | sh",
    });
    expect(servers(c.httpJson).stuga!.url).toBe("http://localhost:8787/mcp");
    expect(c.dshEnv).toContain("STUGA_URL=http://localhost:8787\n");
    expect(c.piUrlEnv).toBe("export STUGA_URL=http://localhost:8787");
    expect(servers(c.desktopJson!).stuga!.env.STUGA_URL).toBe("http://localhost:8787");
  });

  it("gives every node the one name, so a client holds one Stuga connection", () => {
    const [liv, studio] = [clientConfigs(LOCAL, null), clientConfigs({ ...PUBLIC, loopback: true }, null)];
    expect([liv.serverKey, studio.serverKey]).toEqual(["stuga", "stuga"]);
    expect([liv.bundleFilename, studio.bundleFilename]).toEqual(["stuga.mcpb", "stuga.mcpb"]);
    expect(studio.cliCommand).toBe("claude mcp add -s user --transport http stuga https://stuga.example.com/mcp");
    for (const c of [liv, studio]) {
      expect(Object.keys(servers(c.httpJson))).toEqual([c.serverKey]);
      expect(Object.keys(servers(c.desktopJson!))).toEqual([c.serverKey]);
    }
  });

  it("names no node, host or id anywhere a client stores or shows", () => {
    const setup = (id: string, name: string): AgentSetup => ({ ...LOCAL, node: { id, name } });
    for (const s of [setup("abcdefghijklmnop", "家里的 Mac mini"), setup("qrstuvwxyzabcdef", "Livs-MacBook-Pro-2.local")]) {
      const c = clientConfigs(s, null);
      expect(c.serverKey).toBe("stuga");
      expect(`${c.cliCommand} ${c.httpJson} ${c.desktopJson} ${c.installers.codex.setup}`).not.toContain(s.node.id.slice(0, 6));
    }
  });

  it("leaves DeepSeek Harness's environment as it was: the harness names the server itself", () => {
    expect(clientConfigs(LOCAL, null).dshEnv).toBe("STUGA_URL=http://localhost:8787\nSTUGA_API_KEY=vk_your_key_here");
  });

  it("carries the placeholder until a key exists, then the key", () => {
    expect(clientConfigs(PUBLIC, null).httpJson).toContain(`Bearer ${TOKEN_PLACEHOLDER}`);
    const c = clientConfigs(LOCAL, "vk_live_1");
    expect(servers(c.httpJson).stuga!.headers).toEqual({ Authorization: "Bearer vk_live_1" });
    expect(c.dshEnv).toBe("STUGA_URL=http://localhost:8787\nSTUGA_API_KEY=vk_live_1");
    expect(c.piKeyEnv).toBe("export STUGA_API_KEY=vk_live_1");
    expect(clientConfigs(LOCAL, null).piKeyEnv).toBe(`export STUGA_API_KEY=${TOKEN_PLACEHOLDER}`);
    expect(servers(c.desktopJson!).stuga!.env.STUGA_TOKEN).toBe("vk_live_1");
  });

  it("points Pi at the node's origin with no key in it, so the sign-in path carries none", () => {
    for (const setup of [PUBLIC, LOCAL, LAN]) {
      const c = clientConfigs(setup, "vk_live_1");
      expect(c.piUrlEnv).toBe(`export STUGA_URL=${setup.url}`);
      expect(c.piUrlEnv).not.toContain("vk_live_1");
    }
  });

  it("gives Claude Desktop the node's interpreter and server file on a loopback node", () => {
    expect(servers(clientConfigs(LOCAL, null).desktopJson!).stuga).toMatchObject({
      command: "/usr/local/bin/node",
      args: ["/srv/stuga/mcp/index.js"],
    });
  });

  it("sets only variables the stdio server reads, labelling its runs as Claude Desktop", () => {
    const env = servers(clientConfigs(LOCAL, "vk_live_1").desktopJson!).stuga!.env;
    expect(env).toEqual({ STUGA_URL: "http://localhost:8787", STUGA_TOKEN: "vk_live_1", STUGA_CLIENT: "claude-desktop" });
  });

  it("offers no stdio config when the browser does not share the node's machine or the node names no file", () => {
    expect(clientConfigs(PUBLIC, null).desktopJson).toBeNull();
    expect(clientConfigs({ ...LOCAL, stdio: { ...LOCAL.stdio, entry: null } }, null).desktopJson).toBeNull();
  });

  it("points every installer at the node's own origin, with no key anywhere in them", () => {
    for (const setup of [LOCAL, PUBLIC]) {
      // A minted token reaches the other tabs; an installer must never carry one.
      const { installers } = clientConfigs(setup, "vk_live_1");
      for (const commands of Object.values(installers)) {
        for (const command of Object.values(commands)) {
          expect(command.startsWith(`curl -fsSL '${setup.url}/api/agent-install/`)).toBe(true);
          expect(command).not.toContain("vk_live_1");
        }
      }
    }
  });
});
