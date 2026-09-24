import { describe, expect, it } from "vitest";
import { buildInstructions } from "@stuga/agent-surface/instructions";
import type { ResolvedConfig } from "./config.js";
import { configuredNode, identifyNode } from "./node.js";

const CONFIG: ResolvedConfig = { url: "http://livs-air.local:8787", token: "vk_a_b", client: "claude-desktop", version: "0.3.0" };

/** A node whose /auth/config answers `body`, recording what it was asked. */
function answering(body: unknown, status = 200) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetchImpl };
}

/** What a node's /auth/config answers. */
const config = (nodeName: unknown, origin: unknown = "https://studio.example") => ({
  provider: null,
  unclaimed: false,
  node_label: nodeName,
  origin,
  branding: { accent_color: null },
});

describe("configuredNode", () => {
  it("uses the name the installer wrote down, at the configured origin", () => {
    expect(configuredNode({ ...CONFIG, nodeName: "Liv’s Mac" })).toEqual({ name: "Liv’s Mac", origin: "http://livs-air.local:8787" });
  });

  it("falls back to the URL's host, without the port or mDNS's .local", () => {
    expect(configuredNode(CONFIG)).toEqual({ name: "livs-air", origin: "http://livs-air.local:8787" });
  });
});

describe("identifyNode", () => {
  it("asks the node's public /auth/config, whose name and origin win over what was installed", async () => {
    const { asked, fetchImpl } = answering(config("Studio"));
    expect(await identifyNode({ ...CONFIG, nodeName: "Old name" }, fetchImpl)).toEqual({ name: "Studio", origin: "https://studio.example" });
    expect(asked).toEqual(["http://livs-air.local:8787/auth/config"]);
  });

  it("keeps the installed name and the configured origin when the node cannot answer", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    expect(await identifyNode({ ...CONFIG, nodeName: "Liv’s Mac" }, down)).toEqual({ name: "Liv’s Mac", origin: "http://livs-air.local:8787" });
    expect(await identifyNode(CONFIG, answering({ error: "nope" }, 503).fetchImpl)).toEqual(configuredNode(CONFIG));
  });

  it("does not wait long for a node that never answers", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof globalThis.fetch;
    const started = Date.now();
    expect((await identifyNode({ ...CONFIG, nodeName: "Liv’s Mac" }, hang, 20)).name).toBe("Liv’s Mac");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("ignores a name that is not a Stuga node's, and keeps a good origin beside it", async () => {
    for (const name of ["", "   ", 42, "x".repeat(81), "a\nb", "\u200b"]) {
      expect(await identifyNode(CONFIG, answering(config(name)).fetchImpl), JSON.stringify(name)).toEqual({
        name: "livs-air",
        origin: "https://studio.example",
      });
    }
    for (const body of ["Studio", null, { branding: { name: "Studio" } }]) {
      expect(await identifyNode(CONFIG, answering(body).fetchImpl), JSON.stringify(body)).toEqual(configuredNode(CONFIG));
    }
  });

  it("ignores an origin that is not one, and keeps a good name beside it", async () => {
    for (const origin of [42, "", "studio.example", "https://studio.example/", "https://studio.example/path", "javascript:alert(1)"]) {
      expect(await identifyNode(CONFIG, answering(config("Studio", origin)).fetchImpl), JSON.stringify(origin)).toEqual({
        name: "Studio",
        origin: "http://livs-air.local:8787",
      });
    }
  });

  it("opens with the same first line as /mcp, for the same node, when reached at another of its addresses", async () => {
    // /mcp introduces the node by its settings name and PUBLIC_ORIGIN; /auth/config answers exactly those.
    const node = { name: "Liv’s Mac mini", origin: "https://mini.example" };
    const http = buildInstructions({ variant: "http", node }).split("\n")[0];
    const reached = { ...CONFIG, url: "http://127.0.0.1:8787", nodeName: "Stale name" };
    const stdio = buildInstructions({ variant: "stdio", node: await identifyNode(reached, answering(config(node.name, node.origin)).fetchImpl) });
    expect(stdio.split("\n")[0]).toBe(http);
  });
});
