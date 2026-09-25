import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "./config.js";
import { buildProxy, formatForFile, waitingInstructions, withLocalFiles } from "./proxy.js";
import type { Upstream, UpstreamClient } from "./upstream.js";

const CONFIG: ResolvedConfig = { url: "http://127.0.0.1:8787", token: "", client: "claude-desktop", version: "0.3.0" };
const NODE = { name: "Studio", origin: "http://livs-air.local:8787" };
const TOOLS: Tool[] = [
  { name: "search", description: "Find documents.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "databases_add", description: "Add to databases.", inputSchema: { type: "object", properties: { action: { type: "string" } } } },
];
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
  };
  return { client, calls };
}

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
  it("lists the node's tools, offering `file` on the import only", async () => {
    const { client } = await connect({ upstream: upstreamOf(async () => node().client), instructions: "from the node" });
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(["search", "databases_add"]);
    expect(tools[0]!.inputSchema.properties).not.toHaveProperty("file");
    expect(tools[1]!.inputSchema.properties).toHaveProperty("file");
    expect(tools[1]!.description).toContain("action:import also takes `file`");
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
    const res = await call("databases_add", { workspace_id: "ws1", database_id: "db1", table: "Tasks", action: "import", file: "/Users/liv/data.jsonl", on_error: "skip_bad_rows" });
    expect(res).toEqual({ text: "Proposed — the import of 2 rows", isError: false });
    expect(readFile).toHaveBeenCalledWith("/Users/liv/data.jsonl");
    expect(up.calls[0]).toEqual({ name: "databases_add", arguments: { workspace_id: "ws1", database_id: "db1", table: "Tasks", action: "start_import", format: "jsonl" } });
    expect(fetch).toHaveBeenCalledWith(new URL("http://127.0.0.1:8787/api/databases/db1/imports/imp_1/upload?sig=s"), expect.objectContaining({ method: "PUT" }));
    expect(up.calls[1]).toEqual({
      name: "databases_add",
      arguments: { workspace_id: "ws1", database_id: "db1", action: "import", import_id: "imp_1", on_error: "skip_bad_rows" },
    });
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

  it("answers with no tools while the person has not approved the sign-in, and says so on a call", async () => {
    const { client, call } = await connect({ upstream: upstreamOf(() => new Promise(() => {}), "signing-in"), patienceMs: 10 });
    expect((await client.listTools()).tools).toEqual([]);
    const res = await call("search", { q: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("approve the sign-in page");
    expect(client.getInstructions()).toBe(waitingInstructions(NODE));
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
