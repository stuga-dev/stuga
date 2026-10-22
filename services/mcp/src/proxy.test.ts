import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError, type Prompt, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "./config.js";
import type { KeptLists, OfflineCatalog } from "./offline.js";
import { buildProxy, formatForFile, waitingInstructions, withLocalFiles } from "./proxy.js";
import type { Upstream, UpstreamClient } from "./upstream.js";

const CONFIG: ResolvedConfig = { url: "http://127.0.0.1:8787", token: "", client: "claude-desktop", version: "0.3.0" };
const NODE = { name: "Studio", origin: "http://livs-air.local:8787" };
const TOOLS: Tool[] = [
  { name: "search", description: "Find documents.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "databases_add", description: "Add to databases.", inputSchema: { type: "object", properties: { action: { type: "string" } } } },
  { name: "media_upload", description: "Upload.", inputSchema: { type: "object", properties: { action: { type: "string" } } } },
];
const PROMPTS: Prompt[] = [
  { name: "save", title: "Save to Stuga", arguments: [{ name: "text", required: true }] },
  { name: "ask", title: "Ask Stuga", arguments: [{ name: "topic", required: false }] },
];
const OFFLINE = { tools: [TOOLS[0]!], prompts: PROMPTS };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** A node that answers every call from `answer`, recording the calls. */
function node(answer: (name: string, args: Record<string, unknown>) => unknown = () => text("ok")) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const client: UpstreamClient = {
    getInstructions: () => "from the node",
    listTools: vi.fn(async () => ({ tools: TOOLS })),
    callTool: vi.fn(async (params) => {
      calls.push(params as never);
      return answer(params.name, (params.arguments ?? {}) as Record<string, unknown>) as never;
    }),
    listPrompts: vi.fn(async () => ({ prompts: PROMPTS })),
    getPrompt: vi.fn(async (params) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `Save to Stuga: ${String(params.arguments?.text)}` } }],
    })),
  };
  return { client, calls };
}

/** Kept lists in memory, as the catalog file keeps them on disk. */
function memory(initial: Partial<OfflineCatalog> = {}): KeptLists & { lists: Partial<OfflineCatalog> } {
  const kept = { lists: { ...initial } } as KeptLists & { lists: Partial<OfflineCatalog> };
  kept.read = () => ({ ...kept.lists });
  kept.save = (lists) => {
    kept.lists = { ...kept.lists, ...lists };
  };
  return kept;
}

const down = () => upstreamOf(async () => Promise.reject(new Error("cannot reach the Stuga node at http://127.0.0.1:8787: fetch failed")), "failed");

function upstreamOf(ready: () => Promise<UpstreamClient>, state: Upstream["state"] = "ready") {
  return { ready, reset: vi.fn(), state } as Pick<Upstream, "ready" | "reset" | "state"> & { reset: ReturnType<typeof vi.fn> };
}

async function connect(deps: Partial<Parameters<typeof buildProxy>[0]> & { upstream: Parameters<typeof buildProxy>[0]["upstream"] }) {
  const server = buildProxy({ config: CONFIG, node: NODE, ...deps });
  const client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content[0]?.text ?? "", isError: res.isError === true };
  };
  return { client, call };
}

describe("the proxy", () => {
  it("lists the node's tools, offering `file` on the import and the upload only", async () => {
    const { client } = await connect({ upstream: upstreamOf(async () => node().client), instructions: "from the node" });
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(["search", "databases_add", "media_upload"]);
    expect(tools[0]!.inputSchema.properties).not.toHaveProperty("file");
    expect(tools[1]!.inputSchema.properties).toHaveProperty("file");
    expect(tools[1]!.description).toContain("action:import also takes `file`");
    expect(tools[2]!.inputSchema.properties).toHaveProperty("file");
    expect(tools[2]!.description).toContain("action:upload also takes `file`");
    expect(client.getInstructions()).toBe("from the node");
  });

  it("forwards a call unchanged and hands back the node's answer", async () => {
    const up = node(() => text('{"results":[]}'));
    const { call } = await connect({ upstream: upstreamOf(async () => up.client) });
    expect(await call("search", { workspace_ids: ["ws1"], q: "x" })).toEqual({ text: '{"results":[]}', isError: false });
    expect(up.calls).toEqual([{ name: "search", arguments: { workspace_ids: ["ws1"], q: "x" } }]);
  });

  it("uploads a local file: stages the import, PUTs the bytes to the signed path, and commits it", async () => {
    const up = node((name, args) =>
      args.action === "start_import"
        ? text(JSON.stringify({ import_id: "imp_1", upload_path: "/api/databases/db1/imports/imp_1/upload?sig=s", max_bytes: 100, import_page_url: "http://livs-air.local:8787/doc/db1?import" }))
        : text("Proposed — the import of 2 rows"),
    );
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const readFile = vi.fn(async () => new TextEncoder().encode("a,b\n1,2\n"));
    const { call } = await connect({ upstream: upstreamOf(async () => up.client), fetch, readFile });
    const res = await call("databases_add", { workspace_id: "ws1", database_id: "db1", table: "Tasks", action: "import", file: "/Users/liv/data.jsonl", on_error: "skip_bad_rows", revises: ["fb_1"] });
    expect(res).toEqual({ text: "Proposed — the import of 2 rows", isError: false });
    expect(readFile).toHaveBeenCalledWith("/Users/liv/data.jsonl");
    expect(up.calls[0]).toEqual({ name: "databases_add", arguments: { workspace_id: "ws1", database_id: "db1", table: "Tasks", action: "start_import", format: "jsonl" } });
    expect(fetch).toHaveBeenCalledWith(new URL("http://127.0.0.1:8787/api/databases/db1/imports/imp_1/upload?sig=s"), expect.objectContaining({ method: "PUT" }));
    expect(up.calls[1]).toEqual({
      name: "databases_add",
      arguments: { workspace_id: "ws1", database_id: "db1", action: "import", import_id: "imp_1", on_error: "skip_bad_rows", revises: ["fb_1"] },
    });
  });

  it("uploads a local file into a document: stages the upload, PUTs the bytes, and stores it by upload_id", async () => {
    const up = node((_name, args) =>
      args.action === "start_upload"
        ? text(JSON.stringify({ upload_id: "upl_1", upload_path: "/api/docs/d1/media/uploads/upl_1?sig=s", max_bytes: 100 }))
        : text('{"url":"/api/docs/d1/media/h/Q3%20brief.pdf","markdown":"[Q3 brief.pdf](…)"}'),
    );
    const fetch = vi.fn(async () => new Response(null, { status: 201 }));
    const readFile = vi.fn(async () => new TextEncoder().encode("%PDF-1.7"));
    const { call } = await connect({ upstream: upstreamOf(async () => up.client), fetch, readFile });
    const res = await call("media_upload", { workspace_id: "ws1", doc_id: "d1", action: "upload", file: "/Users/liv/Q3 brief.pdf" });
    expect(res.isError).toBe(false);
    expect(up.calls[0]).toEqual({ name: "media_upload", arguments: { workspace_id: "ws1", doc_id: "d1", action: "start_upload", name: "Q3 brief.pdf" } });
    expect(fetch).toHaveBeenCalledWith(new URL("http://127.0.0.1:8787/api/docs/d1/media/uploads/upl_1?sig=s"), expect.objectContaining({ method: "PUT" }));
    expect(up.calls[1]).toEqual({ name: "media_upload", arguments: { workspace_id: "ws1", doc_id: "d1", action: "upload", upload_id: "upl_1" } });

    const big = await connect({ upstream: upstreamOf(async () => node(() => text(JSON.stringify({ upload_id: "u", upload_path: "/u", max_bytes: 3 }))).client), readFile: async () => new Uint8Array(10) });
    expect((await big.call("media_upload", { workspace_id: "ws1", doc_id: "d1", action: "upload", file: "/x.pdf" })).text).toContain("takes files up to 3");
    expect((await big.call("media_upload", { workspace_id: "ws1", doc_id: "d1", action: "upload_from_url", file: "/x.pdf" })).text).toContain("`file` goes with action:upload");
  });

  it("hands a file it cannot upload to the person, and says why a path cannot be read", async () => {
    const staged = text(JSON.stringify({ import_id: "imp_1", upload_path: "/up", max_bytes: 3, import_page_url: "http://node/import" }));
    const up = node(() => staged);
    const big = await connect({ upstream: upstreamOf(async () => up.client), readFile: async () => new Uint8Array(10) });
    const tooBig = await big.call("databases_add", { workspace_id: "ws1", database_id: "db1", table: "T", action: "import", file: "/x.csv" });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.text).toContain("http://node/import");

    const missing = await connect({
      upstream: upstreamOf(async () => node().client),
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    const unread = await missing.call("databases_add", { workspace_id: "ws1", database_id: "db1", table: "T", action: "import", file: "/sandbox/x.csv" });
    expect(unread.text).toContain("a path in your own sandbox is not visible here");
    expect((await missing.call("databases_add", { workspace_id: "ws1", action: "insert_rows", file: "/x.csv" })).text).toContain("`file` goes with action:import");
  });

  it("forwards the node's prompts, and gets one from it", async () => {
    const up = node();
    const { client } = await connect({ upstream: upstreamOf(async () => up.client) });
    expect((await client.listPrompts()).prompts).toEqual(PROMPTS);
    const got = await client.getPrompt({ name: "save", arguments: { text: "Refunds need approval" } });
    expect(got.messages[0]!.content).toEqual({ type: "text", text: "Save to Stuga: Refunds need approval" });
    expect(up.client.getPrompt).toHaveBeenCalledWith({ name: "save", arguments: { text: "Refunds need approval" } });
  });

  it("lists this build's own tools and prompts while the person has not approved the sign-in, and says so on a call", async () => {
    const { client, call } = await connect({
      upstream: upstreamOf(() => new Promise(() => {}), "signing-in"),
      patienceMs: 10,
      listPatienceMs: 10,
      offline: OFFLINE,
    });
    expect((await client.listTools()).tools).toEqual([TOOLS[0]]);
    expect((await client.listPrompts()).prompts).toEqual(PROMPTS);
    const res = await call("search", { q: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("approve the sign-in page");
    await expect(client.getPrompt({ name: "ask", arguments: {} })).rejects.toThrow("approve the sign-in page");
    expect(client.getInstructions()).toBe(waitingInstructions(NODE));
  });

  it("answers a list within its own short wait while a call keeps waiting for the sign-in", async () => {
    // Claude Desktop cancels a list at 30 s; the first sign-in can take longer than that.
    const { client, call } = await connect({
      upstream: upstreamOf(() => new Promise(() => {}), "signing-in"),
      patienceMs: 400,
      listPatienceMs: 10,
      offline: OFFLINE,
    });
    const listedAt = Date.now();
    expect((await client.listTools()).tools).toEqual([TOOLS[0]]);
    expect((await client.listPrompts()).prompts).toEqual(PROMPTS);
    expect(Date.now() - listedAt).toBeLessThan(300);
    const calledAt = Date.now();
    expect((await call("search", { q: "x" })).text).toContain("approve the sign-in page");
    expect(Date.now() - calledAt).toBeGreaterThanOrEqual(350);
  });

  it("keeps its tools listed while the node is down from the start, and says why on a call", async () => {
    const { client, call } = await connect({
      upstream: upstreamOf(async () => Promise.reject(new Error("cannot reach the Stuga node at http://127.0.0.1:8787: fetch failed")), "failed"),
      offline: OFFLINE,
    });
    expect((await client.listTools()).tools).toEqual([TOOLS[0]]);
    expect((await call("search", { q: "x" })).text).toContain("cannot reach the Stuga node");
  });

  it("reconnects through the new sign-in and answers the call, when the node stopped accepting the old one", async () => {
    const refused = node(() => {
      throw new UnauthorizedError("refresh failed");
    });
    const signedIn = node(() => text("after sign-in"));
    let current = refused.client;
    const upstream = upstreamOf(async () => current);
    upstream.reset.mockImplementation(() => {
      current = signedIn.client;
    });
    const { call } = await connect({ upstream });
    expect(await call("search", { q: "x" })).toEqual({ text: "after sign-in", isError: false });
    expect(upstream.reset).toHaveBeenCalledTimes(1);
    expect(signedIn.calls).toEqual([{ name: "search", arguments: { q: "x" } }]);
  });

  it("keeps the node's lists, and lists those rather than this build's while the node is out of reach", async () => {
    const kept = memory();
    const online = await connect({ upstream: upstreamOf(async () => node().client), offline: OFFLINE, kept });
    await online.client.listTools();
    await online.client.listPrompts();
    expect(kept.lists).toEqual({ tools: TOOLS, prompts: PROMPTS });
    const offline = await connect({ upstream: down(), offline: OFFLINE, kept });
    expect((await offline.client.listTools()).tools).toEqual(withLocalFiles(TOOLS));
    expect((await offline.client.listPrompts()).prompts).toEqual(PROMPTS);
  });

  it("lists this build's lists while the node is out of reach and has never listed its own", async () => {
    const { client } = await connect({ upstream: down(), offline: OFFLINE, kept: memory() });
    expect((await client.listTools()).tools).toEqual([TOOLS[0]]);
    expect((await client.listPrompts()).prompts).toEqual(PROMPTS);
  });

  it("answers an older node's missing prompts with none, and keeps none for when it is out of reach", async () => {
    const older = node();
    older.client.listPrompts = vi.fn(async () => {
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    });
    older.client.getPrompt = vi.fn(async () => {
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    });
    const kept = memory({ prompts: PROMPTS });
    const { client } = await connect({ upstream: upstreamOf(async () => older.client), offline: OFFLINE, kept });
    expect((await client.listPrompts()).prompts).toEqual([]);
    expect(kept.lists.prompts).toEqual([]);
    // The node's own error, as it gave it: never "cannot reach".
    const refused = await client.getPrompt({ name: "ask", arguments: {} }).catch((e: unknown) => e as McpError);
    expect(refused).toBeInstanceOf(McpError);
    expect((refused as McpError).code).toBe(ErrorCode.MethodNotFound);
    expect((refused as McpError).message).toBe("MCP error -32601: Method not found");
    const offline = await connect({ upstream: down(), offline: OFFLINE, kept });
    expect((await offline.client.listPrompts()).prompts).toEqual([]);
  });

  it("passes on the node's error answer to a call or a list as the node gave it", async () => {
    const strict = node(() => {
      throw new McpError(ErrorCode.InvalidParams, "Tool nope not found");
    });
    strict.client.listTools = vi.fn(async () => {
      throw new McpError(ErrorCode.InternalError, "the node failed");
    });
    const kept = memory({ tools: TOOLS });
    const { client } = await connect({ upstream: upstreamOf(async () => strict.client), offline: OFFLINE, kept });
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(/^MCP error -32602: Tool nope not found$/);
    await expect(client.listTools()).rejects.toThrow(/^MCP error -32603: the node failed$/);
    expect(kept.lists.tools).toEqual(TOOLS);
  });

  it("reads a request the node did not answer in time as out of reach", async () => {
    const silent = node();
    silent.client.listTools = vi.fn(async () => {
      throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
    });
    const { client, call } = await connect({ upstream: upstreamOf(async () => silent.client), offline: OFFLINE, kept: memory({ tools: TOOLS }) });
    expect((await client.listTools()).tools).toEqual(withLocalFiles(TOOLS));
    silent.client.callTool = vi.fn(async () => {
      throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
    });
    expect((await call("search", { q: "x" })).text).toContain("cannot reach the Stuga node");
  });

  it("says the node could not be reached when a call fails for another reason, and does not retry it", async () => {
    const down = node(() => {
      throw new Error("fetch failed");
    });
    const upstream = upstreamOf(async () => down.client);
    const { call } = await connect({ upstream });
    const res = await call("search", { q: "x" });
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toContain("cannot reach the Stuga node at http://livs-air.local:8787: fetch failed");
    expect(upstream.reset).not.toHaveBeenCalled();
    expect(down.calls).toHaveLength(1);
  });
});

describe("formatForFile and withLocalFiles", () => {
  it("reads the format from the extension unless one is named", () => {
    expect(formatForFile("/a/b.csv", undefined)).toBe("csv");
    expect(formatForFile("/a/b.ndjson", undefined)).toBe("jsonl");
    expect(formatForFile("/a/b.csv", "jsonl")).toBe("jsonl");
    expect(formatForFile("/a/b.xlsx", undefined)).toMatchObject({ error: expect.stringContaining("cannot tell the format") });
  });

  it("leaves every other tool alone", () => {
    expect(withLocalFiles([TOOLS[0]!])).toEqual([TOOLS[0]]);
  });
});
