/** The .mcpb a user installs: the launch environment and the file beside the server carry one credential. */
import { describe, expect, it } from "vitest";
import { buildMcpb, bundleFilename } from "./bundle.js";
import type { BundleConfig, BundleManifest } from "./manifest.js";
import { readZip } from "./zip.test.js";

const NOW = new Date("2026-08-26T12:00:00Z");
const SERVER_JS = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('stuga');\n");
const LICENSE = new TextEncoder().encode("GNU AFFERO GENERAL PUBLIC LICENSE\n");
const THIRD_PARTY = new TextEncoder().encode("Third-party software in stuga-mcp.js\n");
const CFG = {
  url: "https://stuga.test",
  nodeId: "ktbbpahhzxoldakw",
  nodeName: "Liv’s Mac",
  token: "vk_abc123_def456",
  workspace: "ws1",
  stugaVersion: "0.3.0",
};

function build(cfg: BundleConfig = CFG) {
  const entries = readZip(buildMcpb({ serverJs: SERVER_JS, license: LICENSE, thirdPartyLicenses: THIRD_PARTY, cfg, now: NOW })).entries;
  const text = (name: string) => new TextDecoder().decode(entries.find((e) => e.name === name)!.data);
  return { entries, text };
}

describe("buildMcpb", () => {
  it("puts the manifest at the archive root, then the server beside it", () => {
    const { entries } = build();
    expect(entries.map((e) => e.name)).toEqual([
      "manifest.json",
      "icon.png",
      "server/package.json",
      "server/index.js",
      "server/config.json",
      "server/LICENSE",
      "server/third-party-licenses.txt",
    ]);
    expect(bundleFilename).toBe("stuga.mcpb");
  });

  it("carries Stuga's license and the bundled packages' licenses beside the server", () => {
    const { text } = build();
    expect(text("server/LICENSE")).toBe("GNU AFFERO GENERAL PUBLIC LICENSE\n");
    expect(text("server/third-party-licenses.txt")).toBe("Third-party software in stuga-mcp.js\n");
  });

  it("carries the icon the manifest names: a square PNG", () => {
    const { entries, text } = build();
    const manifest = JSON.parse(text("manifest.json")) as BundleManifest;
    const icon = entries.find((e) => e.name === manifest.icon)!.data;
    expect([...icon.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR, the first chunk, holds the width and then the height.
    const ihdr = new DataView(icon.buffer, icon.byteOffset + 16, 8);
    expect([ihdr.getUint32(0), ihdr.getUint32(4)]).toEqual([256, 256]);
  });

  it("carries the minted key in the launch environment", () => {
    const manifest = JSON.parse(build().text("manifest.json")) as BundleManifest;
    expect(manifest.server.mcp_config.env).toMatchObject({
      STUGA_URL: CFG.url,
      STUGA_TOKEN: CFG.token,
      STUGA_CLIENT: "claude-desktop",
      STUGA_VERSION: CFG.stugaVersion,
      STUGA_NODE_NAME: CFG.nodeName,
    });
  });

  it("carries the same credential, client, version and node name in the file the server reads beside itself", () => {
    const config = JSON.parse(build().text("server/config.json")) as Record<string, string>;
    expect(config).toEqual({
      url: CFG.url,
      token: CFG.token,
      client: "claude-desktop",
      version: CFG.stugaVersion,
      node_name: CFG.nodeName,
      workspace: CFG.workspace,
    });
  });

  it("installs two nodes' extensions apart under their ids while showing one product name", () => {
    const other = { ...CFG, url: "https://studio.example", nodeId: "mzxw6ytboi4dqnrq", nodeName: "Studio" };
    const manifest = (cfg: BundleConfig) => JSON.parse(build(cfg).text("manifest.json")) as BundleManifest;
    const [a, b] = [manifest(CFG), manifest(other)];
    expect([a.name, b.name]).toEqual(["stuga-ktbbpahhzxoldakw", "stuga-mzxw6ytboi4dqnrq"]);
    expect([a.display_name, b.display_name]).toEqual(["Stuga", "Stuga"]);
    expect(JSON.parse(build(other).text("server/config.json"))).toMatchObject({ url: other.url, node_name: "Studio" });
  });

  it("leaves a name with `$` to the file beside the server, under the same URL the environment names", () => {
    // The server takes the name from that file only when its URL matches the environment's.
    const { text } = build({ ...CFG, nodeName: "Cash $ Office" });
    const env = (JSON.parse(text("manifest.json")) as BundleManifest).server.mcp_config.env;
    expect(env).not.toHaveProperty("STUGA_NODE_NAME");
    expect(JSON.parse(text("server/config.json"))).toMatchObject({ url: env.STUGA_URL, node_name: "Cash $ Office" });
  });

  it("declares the server as ESM", () => {
    const pkg = JSON.parse(build().text("server/package.json")) as Record<string, unknown>;
    expect(pkg.type).toBe("module");
  });

  it("ships the server bytes verbatim", () => {
    const server = build().entries.find((e) => e.name === "server/index.js")!;
    expect([...server.data]).toEqual([...SERVER_JS]);
  });
});
