/** GET /api/agent-bundle: the extension, offering this node's address and carrying no credential. */
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

const SERVER_JS = new TextEncoder().encode("console.log('stuga');\n");

function humanCtx(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "human-1",
    displayName: "Liv",
    isAgent: false,
    principals: ["user:human-1"],
    workspaceId: "ws1",
    role: "member",
    env: { publicOrigin: "https://stuga.test", nodeId: "ktbbpahhzxoldakw", settings: { current: () => ({ nodeLabel: "Liv’s Mac" }) } },
    ...over,
  } as unknown as Ctx;
}

/** The built artifact present. */
function built(over: BundleSource = {}): BundleSource {
  return { bundlePath: "/srv/stuga/mcp/bundle.js", read: () => SERVER_JS, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/agent-bundle", () => {
  it("is refused to agents by the route table", async () => {
    const agent = humanCtx({ isAgent: true, alias: "agent-1", onBehalfOf: "human-1" } as Partial<Ctx>);
    const res = await routeWorkspaceRequest(agent, new Request("https://node.test/api/agent-bundle"));
    expect(res.status).toBe(403);
  });

  it("answers 503 when there is no built server", async () => {
    const res = await handleAgentBundle(humanCtx(), built({ bundlePath: null }));
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("not built") });
  });

  it("reads the licenses from beside the server, and answers 503 without them rather than ship none", async () => {
    const asked: string[] = [];
    const read = (path: string) => {
      asked.push(path);
      if (path.endsWith("third-party-licenses.txt")) throw new Error("ENOENT");
      return SERVER_JS;
    };
    const res = await handleAgentBundle(humanCtx(), built({ read }));
    expect(asked).toEqual(["/srv/stuga/mcp/bundle.js", "/srv/stuga/mcp/LICENSE", "/srv/stuga/mcp/third-party-licenses.txt"]);
    expect(res.status).toBe(503);
  });

  it("returns the extension as a file the browser saves rather than renders, minting nothing", async () => {
    const res = await handleAgentBundle(humanCtx(), built());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="stuga.mcpb"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(insertApiKey).not.toHaveBeenCalled();
    const text = new TextDecoder().decode(body);
    expect(text).toContain('"name": "stuga"');
    expect(text).toContain('"default": "https://stuga.test"');
    expect(text).not.toMatch(/vk_[0-9a-f]/);
  });
});
