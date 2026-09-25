/** The Claude plugin in integrations/ runs this server from npm: what it passes must be what this server reads. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_URL } from "./config.js";

const plugin = new URL("../../../integrations/", import.meta.url);
const json = (path: string): Record<string, any> => JSON.parse(readFileSync(new URL(path, plugin), "utf8")) as Record<string, any>;

describe("the Claude plugin's source", () => {
  const manifest = json(".claude-plugin/plugin.json");
  const server = json(".mcp.json").mcpServers.stuga;

  it("names no version: a release stamps it and pins the server to it", () => {
    expect(manifest).not.toHaveProperty("version");
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "@stuga/mcp"]);
  });

  it("hands the server the address it asks for, defaulting to the server's own default", () => {
    expect(server.env.STUGA_URL).toBe("${user_config.node_url}");
    expect(manifest.userConfig.node_url.default).toBe(DEFAULT_URL);
  });

  it("is its own marketplace's only plugin", () => {
    expect(json(".claude-plugin/marketplace.json").plugins).toEqual([expect.objectContaining({ name: manifest.name, source: "./" })]);
  });
});
