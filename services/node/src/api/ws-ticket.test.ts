import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
}));

const { getDoc } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
const { verifyWsTicket } = await import("../auth/ws-ticket.js");
import type { Ctx } from "../auth/context.js";
import { personCtx, type CtxOverrides } from "../testing/ctx.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const SECRET = "node-internal-secret";

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  doc_type: "prose",
  acl_principals: ["user:alice", "user:bob"],
  acl_writers: ["user:alice"],
};

const ctx = (overrides: CtxOverrides = {}): Ctx =>
  personCtx({ alias: "alice", displayName: "Alice", principals: ["user:alice"], env: { internalSecret: SECRET }, ...overrides });

function mintFor(c: Ctx, doc = "d1"): Promise<Response> {
  const url = new URL(`https://node.test/api/ws/ticket?doc=${doc}`);
  return routeWorkspaceRequest(c, new Request(url));
}

beforeEach(() => {
  mockGetDoc.mockResolvedValue(DOC);
});

describe("GET /api/ws/ticket", () => {
  it("signs the document, the person, the tenant and the write tier", async () => {
    const res = await mintFor(ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expires_at: number };
    expect(verifyWsTicket(SECRET, body.ticket, "local")).toMatchObject({
      alias: "alice",
      workspaceId: "ws1",
      docId: "d1",
      canWrite: true,
      sid: "sess-1",
      arrival: "local",
    });
  });

  it("signs it for the listener the request came in on: one minted at the remote address opens sockets there only", async () => {
    const res = await mintFor(ctx({ arrival: "remote", sid: "sess-r" }));
    const body = (await res.json()) as { ticket: string };
    expect(verifyWsTicket(SECRET, body.ticket, "local")).toBeNull();
    expect(verifyWsTicket(SECRET, body.ticket, "remote")).toMatchObject({ sid: "sess-r", arrival: "remote" });
  });

  it("gives a reader a read-only ticket", async () => {
    const res = await mintFor(ctx({ alias: "bob", principals: ["user:bob"] }));
    const body = (await res.json()) as { ticket: string };
    expect(verifyWsTicket(SECRET, body.ticket, "local")?.canWrite).toBe(false);
  });

  it("answers 404 for a document in another workspace, even to a principal in its ACL", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, workspace_id: "ws2" });
    expect((await mintFor(ctx())).status).toBe(404);
  });

  it("answers 403 for a document the caller cannot read", async () => {
    expect((await mintFor(ctx({ alias: "mallory", principals: ["user:mallory"] }))).status).toBe(403);
  });

  it("refuses an agent, whose socket opens with its API key", async () => {
    const res = await mintFor(ctx({ isAgent: true, alias: "agent-1", principals: ["agent:agent-1", "user:alice"] }));
    expect(res.status).toBe(403);
  });

  it("answers 400 when no document is named", async () => {
    const url = new URL("https://node.test/api/ws/ticket");
    const res = await routeWorkspaceRequest(ctx(), new Request(url));
    expect(res.status).toBe(400);
  });
});