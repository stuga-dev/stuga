/** The manifest the installer reads before the server ever runs. */
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "@stuga/agent-surface/catalog";
import { buildPrompt } from "@stuga/agent-surface/prompts";
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

  it("lists Save to Stuga, Ask Stuga and Check Stuga as prompts, each its words with the person's in their place", () => {
    expect(bundleManifest(CFG).prompts).toEqual([
      { name: "save", description: expect.any(String), arguments: ["text"], text: "Save to Stuga: ${arguments.text}" },
      {
        name: "ask",
        description: expect.any(String),
        arguments: ["topic"],
        text: "Ask Stuga what my team and I have recorded: for each point, say who last changed its page or row and when, and what still waits for approval. ${arguments.topic}",
      },
      {
        name: "check",
        description: expect.any(String),
        arguments: ["scope"],
        text: "Check Stuga: find the pages that need checking, the pages nothing links to and the broken links, and propose fixes for my approval. ${arguments.scope}",
      },
    ]);
  });

  it("declares templates that read as the server's own prompts, filled or left empty", () => {
    const fill = (text: string, args: Record<string, string>) => text.replace(/\$\{arguments\.(\w+)\}/g, (_, name: string) => args[name] ?? "").trim();
    const said = (name: "save" | "ask" | "check", args: Record<string, string>) => buildPrompt(name, args).messages[0]!.content.text;
    const [save, ask, check] = bundleManifest(CFG).prompts;
    expect(fill(save!.text, { text: "Sam owns billing." })).toBe(said("save", { text: "Sam owns billing." }));
    expect(fill(ask!.text, { topic: "What is Acme's refund window?" })).toBe(said("ask", { topic: "What is Acme's refund window?" }));
    // A client that substitutes nothing for the optional topic sends a whole request, as the server would.
    expect(fill(ask!.text, { topic: "" })).toBe(said("ask", {}));
    expect(fill(check!.text, { scope: "the Policies folder" })).toBe(said("check", { scope: "the Policies folder" }));
    expect(fill(check!.text, { scope: "" })).toBe(said("check", {}));
    expect(said("ask", {})).toBe("Ask Stuga what my team and I have recorded: for each point, say who last changed its page or row and when, and what still waits for approval.");
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
