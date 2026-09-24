/**
 * POST /api/docs/:id/recover: who may ask, which documents are refused, the fallback text
 * forwarded to the actor, and the actor's two refusals as reasons.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  getDocSearchText: vi.fn(async () => "# Notes\n\nthe indexed body"),
}));

const { getDoc } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Notes",
  doc_type: "prose",
  trashed: false,
  locked: false,
  snapshot_seq: 42,
  acl_principals: ["user:owner-1", "user:viv", "agent:agent-1", "org:ws1"],
  acl_writers: ["user:owner-1", "agent:agent-1"],
};

let actorFetch = vi.fn();

function ctxOf(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "owner-1",
    displayName: "Ozzie",
    isAgent: false,
    principals: ["user:owner-1"],
    workspaceId: "ws1",
    role: "member",
    env: { docs: { get: () => ({ fetch: actorFetch }) }, jobs: { send: vi.fn(async () => {}) } },
    ...overrides,
  } as unknown as Ctx;
}

const owner = () => ctxOf();
const admin = () => ctxOf({ alias: "adm", principals: ["org:ws1"], role: "admin" });
const member = () => ctxOf({ alias: "viv", principals: ["user:viv"], role: "member" });
const agent = () => ctxOf({ alias: "agent-1", isAgent: true, onBehalfOf: "owner-1", principals: ["agent:agent-1"] });

async function call(ctx: Ctx): Promise<Response> {
  const path = "/api/docs/d1/recover";
  const req = new Request(`https://node.test${path}`, { method: "POST" });
  return routeWorkspaceRequest(ctx, req);
}

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeEach(() => {
  mockGetDoc.mockReset();
  mockGetDoc.mockResolvedValue({ ...DOC });
  actorFetch = vi.fn(async () => Response.json({ recovered: true, seq: 43, from: { kind: "snapshot", seq: 41 } }));
});

describe("POST /api/docs/:id/recover", () => {
  it("forwards the document's indexed text as the fallback material", async () => {
    const res = await call(owner());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recovered: true, seq: 43 });
    const [url, init] = actorFetch.mock.calls[0]!;
    expect(String(url)).toContain("/recover?docId=d1");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      fallback_markdown: "# Notes\n\nthe indexed body",
    });
  });

  it("lets a workspace admin recover, and refuses a plain member and an agent", async () => {
    expect((await call(admin())).status).toBe(200);
    expect((await call(member())).status).toBe(403);
    expect((await call(agent())).status).toBe(403);
  });

  it("refuses a locked document, as a restore does", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, locked: true });
    const res = await call(owner());
    expect(res.status).toBe(423);
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("answers 404 for a structured database", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, doc_type: "database" });
    expect((await call(owner())).status).toBe(404);
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("says so when the head turned out to be readable", async () => {
    actorFetch = vi.fn(async () => Response.json({ recovered: false, error: "head readable" }, { status: 409 }));
    const res = await call(owner());
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain("nothing to recover");
  });

  it("points at restore when nothing survives to rebuild from", async () => {
    actorFetch = vi.fn(async () => Response.json({ recovered: false, error: "no material" }, { status: 404 }));
    const res = await call(owner());
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain("restore a specific version");
  });
});
