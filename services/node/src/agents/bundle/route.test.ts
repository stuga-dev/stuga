/**
 * POST /api/agent-bundle mints a live credential: it refuses whoever /api/keys
 * refuses, and checks the artifact before the key exists so a failed download
 * leaves no orphan key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  insertApiKey: vi.fn(),
}));

const { insertApiKey } = await import("@stuga/db");
const { handleAgentBundle } = await import("./route.js");
const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
import type { Ctx } from "../../auth/context.js";
import type { BundleSource } from "./route.js";

const mockInsert = insertApiKey as unknown as ReturnType<typeof vi.fn>;

const SERVER_JS = new TextEncoder().encode("console.log('stuga');\n");

function humanCtx(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "human-1",
    displayName: "Ada",
    isAgent: false,
    principals: ["user:human-1"],
    workspaceId: "ws1",
    role: "member",
    env: { publicOrigin: "https://stuga.test", nodeId: "ktbbpahhzxoldakw", settings: { current: () => ({ nodeLabel: "Liv’s Mac" }) } },
    ...over,
  } as unknown as Ctx;
}

/** The built artifact present, and a fixed clock. */
function built(over: BundleSource = {}): BundleSource {
  return { bundlePath: "/srv/stuga/mcp/bundle.js", read: () => SERVER_JS, now: () => new Date("2026-08-26T12:00:00Z"), ...over };
}

function post(body: unknown = {}): Request {
  return new Request("https://node.test/api/agent-bundle", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue(undefined);
});

describe("POST /api/agent-bundle: who may download one", () => {
  it("refuses agents outright, and mints nothing", async () => {
    const agent = humanCtx({ isAgent: true, role: "admin", alias: "agent-1", onBehalfOf: "human-1" });
    const res = await handleAgentBundle(agent, post(), built());
    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("refuses guests, who cannot provision agents at all", async () => {
    const res = await handleAgentBundle(humanCtx({ role: "guest" }), post(), built());
    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("is wired into the route table", async () => {
    const agent = humanCtx({ isAgent: true, alias: "agent-1", onBehalfOf: "human-1" });
    const res = await routeWorkspaceRequest(agent, post());
    expect(res.status).toBe(403);
  });
});

describe("POST /api/agent-bundle: the artifact is checked before the key is minted", () => {
  it("answers 503 when there is no built server, and mints nothing", async () => {
    const res = await handleAgentBundle(humanCtx(), post(), built({ bundlePath: null }));
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("not built"),
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("answers 503 when the artifact vanishes between the probe and the read", async () => {
    const vanished = built({
      read: () => {
        throw new Error("ENOENT");
      },
    });
    const res = await handleAgentBundle(humanCtx(), post(), vanished);
    expect(res.status).toBe(503);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("reads the licenses from beside the server, and answers 503 without them rather than ship none", async () => {
    const asked: string[] = [];
    const read = (path: string) => {
      asked.push(path);
      if (path.endsWith("third-party-licenses.txt")) throw new Error("ENOENT");
      return SERVER_JS;
    };
    const res = await handleAgentBundle(humanCtx(), post(), built({ read }));
    expect(asked).toEqual(["/srv/stuga/mcp/bundle.js", "/srv/stuga/mcp/LICENSE", "/srv/stuga/mcp/third-party-licenses.txt"]);
    expect(res.status).toBe(503);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent-bundle: the download", () => {
  it("returns the extension as a file the browser saves rather than renders", async () => {
    const res = await handleAgentBundle(humanCtx(), post(), built());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="stuga.mcpb"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(res.headers.get("content-length")).toBe(String(body.length));
  });

  it("mints exactly one key, in the workspace the caller is acting in", async () => {
    await handleAgentBundle(humanCtx(), post(), built());
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ owner: "human-1", workspaceId: "ws1", name: "Claude Desktop" }),
    );
  });

  it("takes the name the caller gave it, trimmed", async () => {
    await handleAgentBundle(humanCtx(), post({ name: "  Ada's laptop  " }), built());
    expect(mockInsert).toHaveBeenCalledWith({}, expect.objectContaining({ name: "Ada's laptop" }));
  });

  it("keeps the node as the extension's internal identity while showing the product name", async () => {
    const body = new TextDecoder().decode(await (await handleAgentBundle(humanCtx(), post(), built())).arrayBuffer());
    expect(body).toContain('"name": "stuga-ktbbpahhzxoldakw"');
    expect(body).toContain('"display_name": "Stuga"');
  });

  it("ships the key it minted inside the file", async () => {
    const res = await handleAgentBundle(humanCtx(), post(), built());
    const token = (mockInsert.mock.calls[0]![1] as { keyId: string }).keyId;
    const body = new TextDecoder().decode(await res.arrayBuffer());
    expect(body).toContain(token);
  });
});
