/** The manifest the installer reads before the server ever runs. */
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "@stuga/agent-surface/catalog";
import { bundleManifest, UnsafeBundleValue } from "./manifest.js";

const NOW = new Date("2026-08-26T12:00:00Z");
const CFG = { url: "https://stuga.test", nodeId: "ktbbpahhzxoldakw", nodeName: "Liv’s Mac", token: "vk_abc123_def456", stugaVersion: "0.3.0" };

describe("bundleManifest", () => {
  it("asks the user for nothing", () => {
    expect(bundleManifest(CFG, NOW)).not.toHaveProperty("user_config");
  });

  it("hands the bundled server this node's version", () => {
    const { server } = bundleManifest(CFG, NOW);
    expect(server.mcp_config.env.STUGA_VERSION).toBe("0.3.0");
  });

  it("keeps the installer's sequence number separate from the product version", () => {
    const m = bundleManifest(CFG, NOW);
    expect(m.version).not.toBe(m.server.mcp_config.env.STUGA_VERSION);
  });

  it("launches the host's own runtime against the file it shipped", () => {
    const { server } = bundleManifest(CFG, NOW);
    expect(server.type).toBe("node");
    expect(server.entry_point).toBe("server/index.js");
    expect(server.mcp_config.command).toBe("node");
    expect(server.mcp_config.args).toEqual(["${__dirname}/server/index.js"]);
  });

  it("names a new version on every build, so a re-download installs over the old one", () => {
    expect(bundleManifest(CFG, NOW).version).toBe(`0.1.${Math.floor(NOW.getTime() / 1000)}`);
    expect(bundleManifest(CFG, new Date(NOW.getTime() + 60_000)).version).not.toBe(bundleManifest(CFG, NOW).version);
  });

  it("says where the connection goes without promoting the node name into the product display", () => {
    expect(bundleManifest(CFG, NOW).description).toBe("Read and edit live documents in Stuga. Connected to https://stuga.test.");
    expect(bundleManifest({ ...CFG, workspace: "ws1" }, NOW).description).toContain("ws1");
  });

  it("keeps a stable internal node identity and shows the product name by default", () => {
    const m = bundleManifest(CFG, NOW);
    expect(m.name).toBe("stuga-ktbbpahhzxoldakw");
    expect(m.display_name).toBe("Stuga");
  });

  it("is named apart from another node, and shown under the same product name", () => {
    const twin = bundleManifest({ ...CFG, nodeId: "mzxw6ytboi4dqnrq" }, NOW);
    expect(twin.name).toBe("stuga-mzxw6ytboi4dqnrq");
    expect(twin.name).not.toBe(bundleManifest(CFG, NOW).name);
    expect(twin.display_name).toBe(bundleManifest(CFG, NOW).display_name);
  });

  it("keeps its name when the node is renamed, so a new download replaces the old one", () => {
    expect(bundleManifest({ ...CFG, nodeName: "Studio" }, NOW).name).toBe(bundleManifest(CFG, NOW).name);
  });

  it("hands the server the node's name for the time it cannot ask", () => {
    expect(bundleManifest(CFG, NOW).server.mcp_config.env.STUGA_NODE_NAME).toBe("Liv’s Mac");
  });

  it("leaves a name that substitution would corrupt out of the environment, and still builds", () => {
    const env = bundleManifest({ ...CFG, nodeName: "Cash $ Office" }, NOW).server.mcp_config.env;
    expect(env).not.toHaveProperty("STUGA_NODE_NAME");
    expect(env.STUGA_TOKEN).toBe(CFG.token);
  });

  it("lists the catalog's tools, in order, each with its summary", () => {
    const { tools } = bundleManifest(CFG, NOW);
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) expect(tool.description, tool.name).toBeTruthy();
  });

  it("claims no client version floor", () => {
    expect(bundleManifest(CFG, NOW).compatibility).not.toHaveProperty("claude_desktop");
    expect(bundleManifest(CFG, NOW).manifest_version).toBe("0.3");
  });

  it("refuses a value that variable substitution would corrupt", () => {
    expect(() => bundleManifest({ ...CFG, url: "https://stu$a.test" }, NOW)).toThrow(UnsafeBundleValue);
    expect(() => bundleManifest({ ...CFG, stugaVersion: "0.3.$0" }, NOW)).toThrow(UnsafeBundleValue);
  });
});
