import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
}));

const { getDoc } = await import("@stuga/db");
const { routeWebSocket } = await import("./ws.js");
import type { Ctx } from "../auth/context.js";
import { personCtx, type CtxOverrides } from "../testing/ctx.js";
import type { NodeEnv } from "../env.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;

let actorUrls: string[];
const actorFetch = vi.fn(async (url: string) => {
  actorUrls.push(url);
  // The Response constructor refuses a 101; these cases assert the URL the node built.
  return new Response(null, { status: 200 });
});

const env = {
  docs: { get: () => ({ fetch: actorFetch }) },
  databases: { get: () => ({ fetch: actorFetch }) },
} as unknown as NodeEnv;

const ctx = (principals: string[], extra: CtxOverrides = {}): Ctx =>
  personCtx({ alias: "alice", displayName: "Alice", principals, env, ...extra });

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  doc_type: "prose",
  acl_principals: ["user:alice", "user:bob"],
  acl_writers: ["user:alice"],
};

/** The `write` param the actor was handed for this upgrade. */
async function writeParam(principals: string[], writeCeiling: boolean): Promise<string | null> {
  await routeWebSocket(ctx(principals), env, "d1", null, writeCeiling);
  return new URL(actorUrls.at(-1)!).searchParams.get("write");
}

/** Every param the actor was handed for this upgrade. */
async function upgradeParams(caller: Ctx, agent: string | null = null): Promise<URLSearchParams> {
  await routeWebSocket(caller, env, "d1", agent, true);
  return new URL(actorUrls.at(-1)!).searchParams;
}

beforeEach(() => {
  actorUrls = [];
  actorFetch.mockClear();
  mockGetDoc.mockResolvedValue(DOC);
});

describe("the write tier on an upgrade", () => {
  it("is granted when the ACL and the credential both allow it", async () => {
    expect(await writeParam(["user:alice"], true)).toBe("1");
  });

  it("is refused when the credential does not permit writing, whatever the ACL says", async () => {
    expect(await writeParam(["user:alice"], false)).toBe("0");
  });

  it("is refused when the ACL does not grant it, whatever the credential permits", async () => {
    expect(await writeParam(["user:bob"], true)).toBe("0");
  });

  it("stays the ACL's on a document in the trash, and the actor is told it is there", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, trashed: true });
    const params = await upgradeParams(ctx(["user:alice"]));
    expect(params.get("write")).toBe("1");
    expect(params.get("trashed")).toBe("1");
    mockGetDoc.mockResolvedValue(DOC);
    expect((await upgradeParams(ctx(["user:alice"]))).get("trashed")).toBe("0");
  });

  it("is not sent to a database socket, which carries no edits", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, doc_type: "database" });
    expect(await writeParam(["user:alice"], true)).toBeNull();
  });
});

/** The delegate an agent socket is stamped with comes from the resolved credential, never the caller. */
describe("the delegate on an upgrade", () => {
  it("names the human whose key the agent connected with", async () => {
    const params = await upgradeParams(ctx(["user:alice"], { isAgent: true, onBehalfOf: "liv" }));
    expect(params.get("onBehalfOf")).toBe("liv");
    expect(params.get("agentAuth")).toBe("1");
  });

  it("names nobody for a person acting for themselves", async () => {
    const params = await upgradeParams(ctx(["user:alice"]));
    expect(params.get("onBehalfOf")).toBeNull();
    expect(params.get("agentAuth")).toBeNull();
  });

  it("cannot be set by the one label the client chooses", async () => {
    const params = await upgradeParams(ctx(["user:alice"]), "harness&onBehalfOf=ceo");
    expect(params.get("agent")).toBe("harness&onBehalfOf=ceo");
    expect(params.get("onBehalfOf")).toBeNull();
  });
});

/** A page names the text schema its editor holds; the actor reloads one older than the text. */
describe("the editor's text schema on an upgrade", () => {
  it("is passed on for a page, and not set for a socket no page opened", async () => {
    await routeWebSocket(ctx(["user:alice"]), env, "d1", null, true, "2");
    expect(new URL(actorUrls.at(-1)!).searchParams.get("editorSchema")).toBe("2");
    expect((await upgradeParams(ctx(["user:alice"]))).get("editorSchema")).toBeNull();
  });
});
