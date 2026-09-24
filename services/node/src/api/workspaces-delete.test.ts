/** Deleting a workspace sweeps what outlives its rows: actor storage per document and the media prefix. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", () => ({
  isWorkspaceOwner: vi.fn(async () => true),
  getWorkspace: vi.fn(async () => ({ workspace_id: "ws1", name: "Acme" })),
  deleteWorkspaceCascade: vi.fn(),
}));

const { isWorkspaceOwner, getWorkspace, deleteWorkspaceCascade } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockOwner = isWorkspaceOwner as unknown as ReturnType<typeof vi.fn>;
const mockGetWorkspace = getWorkspace as unknown as ReturnType<typeof vi.fn>;
const mockCascade = deleteWorkspaceCascade as unknown as ReturnType<typeof vi.fn>;
const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});

/** Every actor destroy the handler issued, and every media key it deleted. */
let actorCalls: string[];
let mediaDeleted: string[];
let mediaPages: Array<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
let listPrefixes: string[];

function ctxOf(): Ctx {
  const ns = () => ({ get: () => ({ fetch: async (url: string) => { actorCalls.push(url); return new Response("{}"); } }) });
  return {
    sql: {},
    alias: "owner-1",
    principals: ["user:owner-1"],
    workspaceId: "ws1",
    role: "owner",
    env: {
      docs: ns(),
      databases: ns(),
      jobs: { send: jobsSend },
      media: {
        list: async ({ prefix }: { prefix: string }) => {
          listPrefixes.push(prefix);
          return mediaPages.shift() ?? { objects: [], truncated: false };
        },
        delete: async (keys: string[]) => void mediaDeleted.push(...keys),
      },
    },
  } as unknown as Ctx;
}

async function del(confirm: unknown = "Acme"): Promise<Response> {
  const path = "/api/workspaces/ws1";
  const req = new Request(`https://node.test${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
  return routeWorkspaceRequest(ctxOf(), req);
}

beforeEach(() => {
  actorCalls = [];
  mediaDeleted = [];
  listPrefixes = [];
  mediaPages = [{ objects: [], truncated: false }];
  vi.clearAllMocks();
  mockOwner.mockResolvedValue(true);
  mockGetWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "Acme" });
  mockCascade.mockResolvedValue({ docs: [] });
});

describe("workspace delete: actor storage", () => {
  it("destroys a database doc's actor", async () => {
    mockCascade.mockResolvedValue({ docs: [{ doc_id: "db1", doc_type: "database" }] });
    expect((await del()).status).toBe(200);
    expect(actorCalls).toEqual(["http://actor/destroy?dbId=db1"]);
  });

  it("destroys a prose doc's actor", async () => {
    mockCascade.mockResolvedValue({ docs: [{ doc_id: "d1", doc_type: "prose" }] });
    await del();
    expect(actorCalls).toEqual(["http://actor/destroy?docId=d1"]);
  });

  it("routes each doc to the right namespace in a mixed workspace", async () => {
    // A prose doc addressed as a database would materialize a stray empty database actor.
    mockCascade.mockResolvedValue({
      docs: [
        { doc_id: "d1", doc_type: "prose" },
        { doc_id: "db1", doc_type: "database" },
        { doc_id: "d2", doc_type: "prose" },
      ],
    });
    await del();
    expect(actorCalls).toEqual([
      "http://actor/destroy?docId=d1",
      "http://actor/destroy?dbId=db1",
      "http://actor/destroy?docId=d2",
    ]);
  });

  it("enqueues snapshot GC per doc, each only after its actor is destroyed", async () => {
    const order: string[] = [];
    const recordSweep = async (m: Record<string, unknown>) => void order.push(`gc:${String(m.docId)}`);
    jobsSend.mockImplementationOnce(recordSweep).mockImplementationOnce(recordSweep);
    mockCascade.mockResolvedValue({
      docs: [
        { doc_id: "d1", doc_type: "prose" },
        { doc_id: "db1", doc_type: "database" },
      ],
    });
    const ctx = ctxOf();
    const recordDestroy = (ns: { get: () => { fetch: (url: string) => Promise<Response> } }) => {
      const inner = ns.get();
      ns.get = () => ({ fetch: async (url: string) => (order.push(`destroy:${new URL(url).search.split("=")[1]}`), inner.fetch(url)) });
    };
    recordDestroy((ctx.env as unknown as { docs: { get: () => { fetch: (url: string) => Promise<Response> } } }).docs);
    recordDestroy((ctx.env as unknown as { databases: { get: () => { fetch: (url: string) => Promise<Response> } } }).databases);
    const req = new Request("https://node.test/api/workspaces/ws1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "Acme" }),
    });
    expect((await routeWorkspaceRequest(ctx, req)).status).toBe(200);
    expect(order).toEqual(["destroy:d1", "gc:d1", "destroy:db1", "gc:db1"]);
  });
});

describe("workspace delete: media", () => {
  it("deletes the tenant's whole media prefix, and only that prefix", async () => {
    mediaPages = [{ objects: [{ key: "media/ws1/aa" }, { key: "media/ws1/bb" }], truncated: false }];
    await del();
    expect(listPrefixes).toEqual(["media/ws1/"]);
    expect(mediaDeleted).toEqual(["media/ws1/aa", "media/ws1/bb"]);
  });

  it("follows the listing cursor, so a large workspace is fully cleared", async () => {
    mediaPages = [
      { objects: [{ key: "media/ws1/a" }], truncated: true, cursor: "c1" },
      { objects: [{ key: "media/ws1/b" }], truncated: false },
    ];
    await del();
    expect(mediaDeleted).toEqual(["media/ws1/a", "media/ws1/b"]);
  });

  it("reports success even if the media sweep throws, after the rows are committed", async () => {
    const ctx = ctxOf();
    (ctx.env as unknown as { media: { list: () => Promise<never> } }).media.list = async () => {
      throw new Error("store down");
    };
    const req = new Request("https://node.test/api/workspaces/ws1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "Acme" }),
    });
    const res = await routeWorkspaceRequest(ctx, req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, docs: 0 });
  });
});

describe("workspace delete: gates", () => {
  it("refuses without the exact workspace name", async () => {
    expect((await del("acme")).status).toBe(400);
    expect(actorCalls).toEqual([]);
    expect(mediaDeleted).toEqual([]);
  });

  it("refuses a non-owner", async () => {
    mockOwner.mockResolvedValue(false);
    expect((await del()).status).toBe(403);
  });
});
