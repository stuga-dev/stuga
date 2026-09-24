import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
}));

const { getDoc } = await import("@stuga/db");
const { routeWebSocket } = await import("./ws.js");
import type { Ctx } from "../auth/context.js";
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

function ctx(principals: string[], extra: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "alice",
    displayName: "Alice",
    email: null,
    isAgent: false,
    principals,
    workspaceId: "ws1",
    role: "member",
    env,
    ...extra,
  } as unknown as Ctx;
}

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
