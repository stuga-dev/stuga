/**
 * The /mcp `media` tool: an upload is a document write with the same gates, the
 * type comes from the bytes, and inline base64 has its own smaller cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
}));

const { getDoc } = await import("@stuga/db");
const { handleMcpRequest } = await import("./handler.js");
import { MAX_INLINE_IMAGE_BYTES } from "@stuga/agent-surface/catalog";
import type { Ctx } from "../auth/context.js";
import { DEFAULT_MAX_BODY_BYTES } from "../media/media.js";

// Remote fetches vet the addresses a host resolves to, so a stubbed fetch needs a stubbed resolver.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = btoa(String.fromCharCode(...PNG));

/** A PNG-signed payload of `size` bytes, base64 as an agent sends it. */
function pngBase64(size: number): string {
  const bytes = new Uint8Array(size);
  bytes.set(PNG.subarray(0, 8));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

let puts: string[] = [];

function connectorCtx(): Ctx {
  return {
    sql: {},
    alias: "agent-1",
    displayName: "Connector",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      publicOrigin: "https://stuga.test",
      settings: { current: () => ({ maxBodyBytes: DEFAULT_MAX_BODY_BYTES, nodeLabel: "Studio" }) },
      jobs: { send: vi.fn(async () => {}) },
      aiSettings: { current: () => ({ enabled: false }) },
      media: {
        head: async () => null,
        put: async (k: string) => {
          puts.push(k);
        },
      },
    },
  } as unknown as Ctx;
}

function doc(overrides: Record<string, unknown> = {}) {
  return {
    doc_id: "d1",
    workspace_id: "ws1",
    doc_type: "prose",
    trashed: false,
    locked: false,
    title: "Notes",
    acl_writers: ["agent:agent-1"],
    acl_principals: ["agent:agent-1"],
    ...overrides,
  };
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
  const req = new Request("https://api.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcpRequest(ctx, req);
  const text = await res.text();
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(/data: (.*)/.exec(text)![1]!)
    : JSON.parse(text);
  const result = payload.result ?? {};
  return { isError: result.isError === true, text: String(result.content?.[0]?.text ?? "") };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  puts = [];
  mockGetDoc.mockResolvedValue(doc());
});

describe("media upload", () => {
  it("stores base64 bytes and hands back a path plus ready-to-paste markdown", async () => {
    const r = await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload", data: PNG_B64, alt: "A chart" });
    expect(r.isError).toBe(false);
    const json = JSON.parse(r.text.split("\n[note]")[0]!);
    expect(json.url).toMatch(/^\/api\/docs\/d1\/media\/[0-9a-f]{64}$/);
    expect(json.mime).toBe("image/png");
    expect(json.markdown).toBe(`![A chart](${json.url})`);
    expect(puts).toEqual([`media/ws1/${json.hash}`]);
    expect(r.text).toMatch(/does not place the image/);
  });

  it("puts a caption in the markdown title slot, escaped the way the serializer does", async () => {
    const r = await callTool(connectorCtx(), "media", {
      doc_id: "d1",
      action: "upload",
      data: PNG_B64,
      alt: "A chart",
      caption: 'Figure 1 — "Q3" revenue',
    });
    const json = JSON.parse(r.text.split("\n[note]")[0]!);
    expect(json.markdown).toBe(`![A chart](${json.url} "Figure 1 — \\"Q3\\" revenue")`);
  });

  it("omits the title slot entirely when there is no caption", async () => {
    const r = await callTool(connectorCtx(), "media", {
      doc_id: "d1",
      action: "upload",
      data: PNG_B64,
      alt: "A chart",
      caption: "   ",
    });
    const json = JSON.parse(r.text.split("\n[note]")[0]!);
    expect(json.markdown).toBe(`![A chart](${json.url})`);
  });

  it("accepts a whole data: URI where raw base64 was asked for", async () => {
    const r = await callTool(connectorCtx(), "media", {
      doc_id: "d1",
      action: "upload",
      data: `data:image/png;base64,${PNG_B64}`,
    });
    expect(r.isError).toBe(false);
    expect(puts).toHaveLength(1);
  });

  it("refuses an SVG however it is labelled", async () => {
    const r = await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload", data: btoa("<svg/>") });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/SVG is not accepted/);
    expect(puts).toEqual([]);
  });

  it("stores an inline payload at the base64 budget, a request body past the MCP SDK's own default", async () => {
    const data = pngBase64(MAX_INLINE_IMAGE_BYTES);
    expect(data.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    const r = await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload", data });
    expect(r.isError).toBe(false);
    expect(puts).toHaveLength(1);
  });

  it("refuses an inline payload past the smaller base64 budget", async () => {
    const data = pngBase64(MAX_INLINE_IMAGE_BYTES + 16);
    const r = await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload", data });
    expect(r.isError).toBe(true);
    expect(puts).toEqual([]);
  });

  it("downloads from a URL and reports the sniffed type, not the served one", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(PNG, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    const r = await callTool(connectorCtx(), "media", {
      doc_id: "d1",
      action: "upload_from_url",
      url: "https://cdn.example.com/c.png",
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text.split("\n[note]")[0]!).mime).toBe("image/png");
  });

  it("refuses a URL pointed at the instance-metadata address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await callTool(connectorCtx(), "media", {
      doc_id: "d1",
      action: "upload_from_url",
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(r.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the missing argument for each action", async () => {
    expect((await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload" })).text).toMatch(/`data`/);
    expect((await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload_from_url" })).text).toMatch(/`url`/);
  });
});

describe("an upload is a document write", () => {
  it("refuses view-only access", async () => {
    mockGetDoc.mockResolvedValue(doc({ acl_writers: ["user:someone-else"] }));
    const r = await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload", data: PNG_B64 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no write access/);
    expect(puts).toEqual([]);
  });

  it("refuses a locked document", async () => {
    mockGetDoc.mockResolvedValue(doc({ locked: true }));
    const r = await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload", data: PNG_B64 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/locked/);
    expect(puts).toEqual([]);
  });

  it("refuses a document in another workspace as not found", async () => {
    mockGetDoc.mockResolvedValue(doc({ workspace_id: "ws2" }));
    const r = await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload", data: PNG_B64 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });

  it("redirects a database doc to the databases tools", async () => {
    mockGetDoc.mockResolvedValue(doc({ doc_type: "database" }));
    const r = await callTool(connectorCtx(), "media", { doc_id: "d1", action: "upload", data: PNG_B64 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/structured database/);
  });
});
