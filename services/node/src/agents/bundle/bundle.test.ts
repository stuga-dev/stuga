/** The .mcpb a user installs: no credential anywhere in it, and the node it came from offered as the address. */
import { describe, expect, it } from "vitest";
import { buildMcpb, bundleFilename } from "./bundle.js";
import type { BundleConfig, BundleManifest } from "./manifest.js";
import { readZip } from "../../lib/testing/read-zip.js";

const SERVER_JS = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('stuga');\n");
const LICENSE = new TextEncoder().encode("GNU AFFERO GENERAL PUBLIC LICENSE\n");
const THIRD_PARTY = new TextEncoder().encode("Third-party software in stuga-mcp.js\n");
const CFG = { url: "https://stuga.test", stugaVersion: "0.3.0" };

function build(cfg: BundleConfig = CFG) {
  const entries = readZip(buildMcpb({ serverJs: SERVER_JS, license: LICENSE, thirdPartyLicenses: THIRD_PARTY, cfg })).entries;
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

  it("carries no credential, only the node it came from for a host that passes no environment", () => {
    const { entries, text } = build();
    expect(JSON.parse(text("server/config.json"))).toEqual({ url: CFG.url, client: "claude-desktop", version: CFG.stugaVersion });
    for (const entry of entries) expect(new TextDecoder().decode(entry.data), entry.name).not.toMatch(/vk_[0-9a-f]|sto_|str_/);
  });

  it("is the same extension, bar the address it offers, whichever node it came from", () => {
    const manifest = (cfg: BundleConfig) => JSON.parse(build(cfg).text("manifest.json")) as BundleManifest;
    const [a, b] = [manifest(CFG), manifest({ ...CFG, url: "https://studio.example" })];
    expect([a.name, b.name]).toEqual(["stuga", "stuga"]);
    expect(b.user_config.node_url.default).toBe("https://studio.example");
  });

  it("declares the server as ESM", () => {
    const pkg = JSON.parse(build().text("server/package.json")) as Record<string, unknown>;
    expect(pkg.type).toBe("module");
  });

  it("stores every entry uncompressed, which the installer needs", () => {
    expect(build().entries.filter((e) => e.method !== 0).map((e) => e.name)).toEqual([]);
  });

  it("ships the server bytes verbatim", () => {
    const server = build().entries.find((e) => e.name === "server/index.js")!;
    expect([...server.data]).toEqual([...SERVER_JS]);
  });
});
