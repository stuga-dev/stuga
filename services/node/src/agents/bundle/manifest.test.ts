/** The manifest the installer reads before the server ever runs. */
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "@stuga/agent-surface/catalog";
import { bundleManifest, UnsafeBundleValue } from "./manifest.js";

const CFG = { url: "https://stuga.test", stugaVersion: "0.3.0" };

describe("bundleManifest", () => {
  it("is one extension for every node, versioned as Stuga, so a newer download replaces the old one", () => {
    const m = bundleManifest(CFG);
    expect(m.name).toBe("stuga");
    expect(m.display_name).toBe("Stuga");
    expect(m.version).toBe("0.3.0");
    expect(bundleManifest({ ...CFG, url: "https://other.test" }).name).toBe(m.name);
  });

  it("asks for the node's address, offering the node it came from, and takes a key only if the person has one", () => {
    const { user_config } = bundleManifest(CFG);
    expect(user_config.node_url).toMatchObject({ type: "string", required: true, default: "https://stuga.test" });
    expect(user_config.access_key).toMatchObject({ type: "string", required: false, sensitive: true });
    expect(user_config.access_key.description).toContain("sign in through your browser");
  });

  it("hands the server what the person entered, and no credential of its own", () => {
    const { env } = bundleManifest(CFG).server.mcp_config;
    expect(env).toEqual({
      STUGA_URL: "${user_config.node_url}",
      STUGA_TOKEN: "${user_config.access_key}",
      STUGA_CLIENT: "claude-desktop",
      STUGA_VERSION: "0.3.0",
    });
    expect(JSON.stringify(bundleManifest(CFG))).not.toMatch(/vk_|sto_|str_/);
  });

  it("launches the host's own runtime against the file it shipped", () => {
    const { server } = bundleManifest(CFG);
    expect(server.type).toBe("node");
    expect(server.entry_point).toBe("server/index.js");
    expect(server.mcp_config.command).toBe("node");
    expect(server.mcp_config.args).toEqual(["${__dirname}/server/index.js"]);
  });

  it("lists the catalog's tools, in order, each with its summary", () => {
    const { tools } = bundleManifest(CFG);
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const tool of tools) expect(tool.description, tool.name).toBeTruthy();
  });

  it("claims no client version floor", () => {
    expect(bundleManifest(CFG).compatibility).not.toHaveProperty("claude_desktop");
    expect(bundleManifest(CFG).manifest_version).toBe("0.3");
  });

  it("refuses a value that variable substitution would corrupt", () => {
    expect(() => bundleManifest({ ...CFG, url: "https://stu$a.test" })).toThrow(UnsafeBundleValue);
    expect(() => bundleManifest({ ...CFG, stugaVersion: "0.3.$0" })).toThrow(UnsafeBundleValue);
  });
});
