/** Whether a hosted connector can dial this node, and which local server a client launches. */
import { describe, expect, it } from "vitest";
import { agentSetup, isLoopbackOrigin, isPrivateHost, isSecureOrigin, mcpBundlePath, reachableFromInternet } from "./setup.js";
import { routeWorkspaceRequest } from "../http/dispatch.js";
import type { Ctx } from "../auth/context.js";

describe("reachableFromInternet", () => {
  it.each([
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://127.13.2.9",
    "http://10.0.4.20:3000",
    "http://172.16.0.1",
    "http://172.31.255.254",
    "http://192.168.1.14:8787",
    "http://169.254.10.1",
    "http://[::1]:8787",
    "http://[fd12:3456:789a::1]",
    "http://[fc00::1]",
    "http://[FE80::1]:8787",
    "http://Stuga.local",
    "https://node.internal",
    "http://stuga.home.arpa",
    "http://desktop:8787",
    "not a url",
  ])("%s cannot be dialled from outside", (origin) => {
    expect(reachableFromInternet(origin)).toBe(false);
  });

  it.each([
    "https://stuga.example.com",
    "https://STUGA.EXAMPLE.COM",
    "https://node.example.com:8443",
    "http://172.32.0.1",
    "http://172.15.0.1",
    "http://11.0.0.1",
    "http://193.168.1.1",
    "http://169.253.10.1",
    "http://8.8.8.8",
    "http://[2606:4700::1111]",
    "http://[fec0::1]",
  ])("%s can", (origin) => {
    expect(reachableFromInternet(origin)).toBe(true);
  });

  it("does not care how the caller spells the host", () => {
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("LOCALHOST")).toBe(true);
    expect(isPrivateHost("Example.COM")).toBe(false);
  });
});

describe("agentSetup", () => {
  const BUNDLE = "/srv/stuga/services/mcp/dist/stuga-mcp.js";
  const probe = { command: "/usr/local/bin/node", bundlePath: BUNDLE };
  const NODE = { id: "ktbbpahhzxoldakw", name: "Liv’s Mac" };

  it("hands a local client the bundled server when packaging names no entry", () => {
    const setup = agentSetup("http://localhost:8787", NODE, probe);
    expect(setup).toEqual({
      url: "http://localhost:8787",
      mcp_url: "http://localhost:8787/mcp",
      node: { id: "ktbbpahhzxoldakw", name: "Liv’s Mac" },
      reachable: false,
      loopback: true,
      secure: true,
      bundle: { available: true },
      stdio: { command: "/usr/local/bin/node", entry: BUNDLE },
    });
  });

  it("uses the entry packaging names instead", () => {
    const setup = agentSetup("http://localhost:8787", NODE, { ...probe, stdioEntry: "/opt/stuga/mcp.js" });
    expect(setup.stdio.entry).toBe("/opt/stuga/mcp.js");
    expect(setup.bundle.available).toBe(true);
  });

  it("reports no local entry when packaging says there is none, and keeps the extension", () => {
    const setup = agentSetup("http://localhost:8787", NODE, { ...probe, stdioEntry: "" });
    expect(setup.stdio.entry).toBeNull();
    expect(setup.bundle.available).toBe(true);
  });

  it("reports neither when the server was never built", () => {
    const setup = agentSetup("https://stuga.example.com", NODE, { ...probe, bundlePath: null });
    expect(setup.stdio.entry).toBeNull();
    expect(setup.bundle.available).toBe(false);
    expect(setup.reachable).toBe(true);
  });

  it("resolves the bundle through the package export, not the working directory", () => {
    const path = mcpBundlePath();
    if (path !== null) expect(path).toMatch(/services[/\\]mcp[/\\]dist[/\\]stuga-mcp\.js$/);
    expect(agentSetup("http://localhost:8787", NODE).bundle.available).toBe(path !== null);
  });
});

describe("GET /api/agent-setup", () => {
  const env = { publicOrigin: "http://localhost:8787", nodeId: "ktbbpahhzxoldakw", settings: { current: () => ({ nodeLabel: "Studio" }) } };
  const answer = async (over: Partial<Ctx>) => {
    const ctx = { alias: "human-1", isAgent: false, principals: ["user:human-1"], workspaceId: "ws1", role: "member", env, ...over } as unknown as Ctx;
    const res = await routeWorkspaceRequest(ctx, new Request("https://node.test/api/agent-setup"));
    expect(res.status).toBe(200);
    return res.json();
  };

  it("answers an ordinary member, naming this node", async () => {
    expect(await answer({})).toMatchObject({
      url: "http://localhost:8787",
      mcp_url: "http://localhost:8787/mcp",
      node: { id: "ktbbpahhzxoldakw", name: "Studio" },
      reachable: false,
    });
  });

  it("gives an API key the same answer", async () => {
    const agent = await answer({ alias: "agent-1", isAgent: true, onBehalfOf: "human-1", principals: ["agent:agent-1", "user:human-1"] });
    expect(agent).toEqual(await answer({}));
  });
});

describe("isSecureOrigin", () => {
  it.each([
    ["https://stuga.example.com", true],
    ["http://localhost:8787", true],
    ["http://127.0.0.1:8787", true],
    ["http://[::1]:8787", true],
    // The LAN addresses a node is reached at by default: a browser sign-in cannot end here.
    ["http://livs-air.local:8787", false],
    ["http://192.168.1.50:8787", false],
    ["http://nas:8787", false],
    ["not-a-url", false],
  ])("reports %s as secure: %s", (origin, expected) => {
    expect(isSecureOrigin(origin)).toBe(expected);
  });
});

describe("isLoopbackOrigin", () => {
  it.each([
    ["http://localhost:8787", true],
    ["http://127.0.0.1:8787", true],
    ["http://127.13.2.9", true],
    ["http://[::1]:8787", true],
    ["https://app.localhost", true],
    ["http://192.168.1.9:8787", false],
    ["http://nas:8787", false],
    ["https://stuga.example.com", false],
    ["not-a-url", false],
  ])("reports loopback for %s as %s", (origin, expected) => {
    expect(isLoopbackOrigin(origin)).toBe(expected);
  });
});
