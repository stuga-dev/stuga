/**
 * The /mcp `media_upload` tool: an upload is a document write with the same gates,
 * the type comes from the bytes, inline base64 has its own smaller cap, and a larger
 * file is staged and sent to a signed URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  listWorkspacesForUser: vi.fn(async () => []),
}));

vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  workspaceContextFor: vi.fn(),
}));

const { getDoc } = await import("@stuga/db");
const { workspaceContextFor } = await import("../auth/context.js");
const { callerFor, resolvingTo, inWorkspace, callToolAs } = await import("./testing/call.js");
import { MAX_INLINE_IMAGE_BYTES } from "@stuga/agent-surface/catalog";
import { MemoryBlobStore } from "@stuga/runtime/testing";
import type { Ctx } from "../auth/context.js";
import type { NodeEnv } from "../env.js";
import { agentCtx, fixed, recordingJobs } from "../testing/ctx.js";
import { DEFAULT_MAX_BODY_BYTES } from "../media/media.js";
import { handleMediaUpload } from "../media/uploads.js";

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
let snapshots = new MemoryBlobStore();

function connectorCtx(alias?: string): Ctx {
  return agentCtx({
    ...(alias ? { alias } : {}),
    principals: ["agent:agent-1"],
    env: {
      snapshots: snapshots,
      internalSecret: "s".repeat(32),
      settings: fixed({ maxBodyBytes: DEFAULT_MAX_BODY_BYTES, nodeLabel: "Studio" }),
      jobs: recordingJobs(),
      aiSettings: fixed({ enabled: false }),
      media: {
        head: async () => null,
        put: async (k: string) => {
          puts.push(k);
        },
      },
    },
  });
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

/** One call run in `ctx`'s workspace, which is the only one the gate resolves. */
async function callTool(ctx: Ctx, name: string, args: Record<string, unknown> = {}) {
  vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctx));
  return callToolAs(callerFor(ctx), name, inWorkspace(ctx.workspaceId, name, args));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  puts = [];
  snapshots = new MemoryBlobStore();
  mockGetDoc.mockResolvedValue(doc());
});

describe("media upload", () => {
  it("stores base64 bytes and hands back a path plus ready-to-paste markdown", async () => {
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data: PNG_B64, alt: "A chart" });
    expect(r.isError).toBe(false);
    const json = JSON.parse(r.text.split("\n[note]")[0]!);
    expect(json.url).toMatch(/^\/api\/docs\/d1\/media\/[0-9a-f]{64}$/);
    expect(json.mime).toBe("image/png");
    expect(json.markdown).toBe(`![A chart](${json.url})`);
    expect(puts).toEqual([`media/ws1/${json.hash}`]);
    expect(r.text).toMatch(/does not place the image/);
  });

  it("puts a caption in the markdown title slot, escaped the way the serializer does", async () => {
    const r = await callTool(connectorCtx(), "media_upload", {
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
    const r = await callTool(connectorCtx(), "media_upload", {
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
    const r = await callTool(connectorCtx(), "media_upload", {
      doc_id: "d1",
      action: "upload",
      data: `data:image/png;base64,${PNG_B64}`,
    });
    expect(r.isError).toBe(false);
    expect(puts).toHaveLength(1);
  });

  it("keeps any other file, an SVG among them, as a file people download, linked by the name it is given", async () => {
    const unnamed = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data: btoa("<svg/>") });
    expect(unnamed.text).toBe("error: name the file: pass `name`, such as report.pdf");
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data: btoa("<svg/>"), name: "logo.svg" });
    expect(r.isError).toBe(false);
    const json = JSON.parse(r.text.split("\n[note]")[0]!);
    expect(json).toMatchObject({ mime: "image/svg+xml", name: "logo.svg", markdown: `[logo.svg](/api/docs/d1/media/${json.hash}/logo.svg)` });
    expect(puts).toEqual([`media/ws1/${json.hash}`]);
    expect(r.text).toMatch(/does not place the file/);
  });

  it("stages a larger file: a signed PUT takes it once, and upload stores it by upload_id for whoever started it", async () => {
    const ctx = connectorCtx();
    const staged = await callTool(ctx, "media_upload", { doc_id: "d1", action: "start_upload", name: "Q3 brief.pdf" });
    const ticket = JSON.parse(staged.text) as { upload_id: string; upload_path: string; max_bytes: number };
    expect(ticket.max_bytes).toBe(10 * 1024 * 1024);
    const url = new URL(ticket.upload_path, "http://node");
    const put = (sig: string | null) =>
      handleMediaUpload(ctx.env as NodeEnv, new Request(url, { method: "PUT", body: "%PDF-1.7" }), "d1", ticket.upload_id, sig);
    expect((await put("0".repeat(64))).status).toBe(403);
    expect((await put(url.searchParams.get("sig"))).status).toBe(201);
    expect((await put(url.searchParams.get("sig"))).status).toBe(409);
    const other = await callTool(connectorCtx("agent-2"), "media_upload", { doc_id: "d1", action: "upload", upload_id: ticket.upload_id });
    expect(other.text).toBe("error: this upload was started by another credential");
    const r = await callTool(ctx, "media_upload", { doc_id: "d1", action: "upload", upload_id: ticket.upload_id });
    const json = JSON.parse(r.text.split("\n[note]")[0]!);
    expect(json).toMatchObject({ mime: "application/pdf", name: "Q3 brief.pdf", markdown: `[Q3 brief.pdf](/api/docs/d1/media/${json.hash}/Q3%20brief.pdf)` });
    // Taken: the staging is gone.
    expect((await callTool(ctx, "media_upload", { doc_id: "d1", action: "upload", upload_id: ticket.upload_id })).isError).toBe(true);
  });

  it("stores an inline payload at the base64 budget, a request body past the MCP SDK's own default", async () => {
    const data = pngBase64(MAX_INLINE_IMAGE_BYTES);
    expect(data.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data });
    expect(r.isError).toBe(false);
    expect(puts).toHaveLength(1);
  });

  it("refuses an inline payload past the smaller base64 budget", async () => {
    const data = pngBase64(MAX_INLINE_IMAGE_BYTES + 16);
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data });
    expect(r.isError).toBe(true);
    expect(puts).toEqual([]);
  });

  it("downloads from a URL and reports the sniffed type, not the served one", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(PNG, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    const r = await callTool(connectorCtx(), "media_upload", {
      doc_id: "d1",
      action: "upload_from_url",
      url: "https://cdn.example.com/c.png",
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text.split("\n[note]")[0]!).mime).toBe("image/png");
  });

  it("downloads any other file from a URL, named for its last segment unless given a name", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("%PDF-1.7", { status: 200 }));
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload_from_url", url: "https://cdn.example.com/files/Q3%20brief.pdf?v=2" });
    expect(JSON.parse(r.text.split("\n[note]")[0]!)).toMatchObject({ mime: "application/pdf", name: "Q3 brief.pdf" });
    const named = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload_from_url", url: "https://cdn.example.com/dl?id=7", name: "Minutes.pdf" });
    expect(JSON.parse(named.text.split("\n[note]")[0]!).name).toBe("Minutes.pdf");
  });

  it("refuses a URL pointed at the instance-metadata address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await callTool(connectorCtx(), "media_upload", {
      doc_id: "d1",
      action: "upload_from_url",
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(r.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the missing argument for each action", async () => {
    expect((await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload" })).text).toMatch(/`data`/);
    expect((await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload_from_url" })).text).toMatch(/`url`/);
  });
});

describe("an upload is a document write", () => {
  it("refuses view-only access", async () => {
    mockGetDoc.mockResolvedValue(doc({ acl_writers: ["user:someone-else"] }));
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data: PNG_B64 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no write access/);
    expect(puts).toEqual([]);
  });

  it("refuses a locked document", async () => {
    mockGetDoc.mockResolvedValue(doc({ locked: true }));
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data: PNG_B64 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/locked/);
    expect(puts).toEqual([]);
  });

  it("refuses a document in another workspace as not found", async () => {
    mockGetDoc.mockResolvedValue(doc({ workspace_id: "ws2" }));
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data: PNG_B64 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });

  it("stores a database's file under its id, image or not, and says the link goes in a files cell", async () => {
    mockGetDoc.mockResolvedValue(doc({ doc_type: "database" }));
    const r = await callTool(connectorCtx(), "media_upload", { doc_id: "d1", action: "upload", data: PNG_B64, name: "chart.png" });
    expect(r.isError).toBe(false);
    const json = JSON.parse(r.text.split("\n[note]")[0]!);
    expect(json).toEqual({ url: `/api/docs/d1/media/${json.hash}/chart.png`, hash: json.hash, size: PNG.length, mime: "image/png", name: "chart.png" });
    expect(puts).toEqual([`media/ws1/d1/${json.hash}`]);
    expect(r.text).toMatch(/files column's cell/);
  });
});
