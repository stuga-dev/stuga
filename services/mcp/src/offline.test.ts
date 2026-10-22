import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import { READ_TOOLS, TOOL_NAMES } from "@stuga/agent-surface/catalog";
import { PROMPT_NAMES } from "@stuga/agent-surface/prompts";
import { CatalogFile, catalogKey, offlineCatalog } from "./offline.js";

describe("the offline catalog", () => {
  it("lists every tool and prompt this build offers, schemas and hints included", async () => {
    const { tools, prompts } = await offlineCatalog();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES]);
    const remember = tools.find((t) => t.name === "remember");
    expect(remember?.title).toBe("Save to Stuga");
    expect(remember?.inputSchema.type).toBe("object");
    expect(Object.keys(remember?.inputSchema.properties ?? {})).toEqual(["workspace_id", "points"]);
    expect(remember?.annotations?.readOnlyHint).toBe(false);
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual([...READ_TOOLS]);
  });
});

describe("the catalog file", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "stuga-catalog-")), "stuga", "catalog.json");
  const TOOL: Tool = { name: "search", inputSchema: { type: "object" } };
  const PROMPT: Prompt = { name: "ask" };

  it("keeps each connection's lists apart, in a file only this user can read", () => {
    const path = file();
    const catalog = new CatalogFile(path);
    catalog.forKey("http://a").save({ tools: [TOOL] });
    catalog.forKey("http://a").save({ prompts: [PROMPT] });
    catalog.forKey("http://b").save({ prompts: [] });
    expect(catalog.read("http://a")).toEqual({ tools: [TOOL], prompts: [PROMPT] });
    expect(new CatalogFile(path).read("http://b")).toEqual({ prompts: [] });
    expect(catalog.read("http://c")).toEqual({});
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads a damaged file or list as nothing kept", () => {
    const path = file();
    const catalog = new CatalogFile(path);
    catalog.save("http://a", { tools: [TOOL] });
    writeFileSync(path, "{not json");
    expect(catalog.read("http://a")).toEqual({});
    writeFileSync(path, JSON.stringify({ "http://a": { tools: [{ name: 1 }], prompts: [PROMPT] } }));
    expect(catalog.read("http://a")).toEqual({ prompts: [PROMPT] });
  });

  it("keeps a sign-in's lists under the node's address, and a key's under a digest of it as well", () => {
    expect(catalogKey({ url: "http://a", token: "" })).toBe("http://a");
    const key = catalogKey({ url: "http://a", token: "stk_one" });
    expect(key).toMatch(/^http:\/\/a key:[0-9a-f]{16}$/);
    expect(key).not.toContain("stk_one");
    expect(catalogKey({ url: "http://a", token: "stk_two" })).not.toBe(key);
  });
});
