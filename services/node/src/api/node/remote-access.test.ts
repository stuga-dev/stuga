/** /api/node/remote-access: shown, turned on with a code, turned off; by a person who administers the node. */
import { describe, expect, it, vi } from "vitest";
import type { RemoteAccessStatus } from "@stuga/protocol/api/remote-access";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  isNodeAdminAlias: vi.fn(async () => true),
}));
vi.mock("../../audit/record.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../audit/record.js")>()),
  recordAudit: vi.fn(),
}));

const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
const { recordAudit } = await import("../../audit/record.js");
const { RemoteAccessRefusal } = await import("../../remote/service.js");
const { isNodeAdminAlias } = await import("@stuga/db");
const { agentCtx, personCtx } = await import("../../testing/ctx.js");
import type { Ctx } from "../../auth/context.js";
import type { RemoteAccess } from "../../remote/service.js";

const audit = recordAudit as unknown as ReturnType<typeof vi.fn>;

const ON: RemoteAccessStatus = {
  available: true,
  enabled: true,
  state: "starting",
  address: "https://k7f3q2.mystuga.com",
  certificate: null,
  credential: null,
  connector: null,
  ca_terms: { accepted_by: "admin-1", accepted_at: "2026-10-02T00:13:10.000Z", url: null },
  last_error: null,
};

function remoteAccess(over: Partial<RemoteAccess> = {}): RemoteAccess {
  return {
    view: { current: () => ({ enabled: true, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", origin: "https://k7f3q2.mystuga.com" }) },
    start: vi.fn(),
    stop: vi.fn(),
    kick: vi.fn(),
    status: vi.fn(async () => ON),
    enable: vi.fn(async () => ({ status: ON, via: "enroll" as const })),
    disable: vi.fn(async () => ({ ...ON, enabled: false, state: "off" as const })),
    ...over,
  };
}

const node = (remote?: RemoteAccess, agent = false): Ctx =>
  (agent ? agentCtx : personCtx)({ alias: agent ? "agent-1" : "admin-1", env: remote ? { remoteAccess: remote } : {} });

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return routeWorkspaceRequest(ctx, new Request(`https://stuga.test${path}`, init));
}

describe("where the packaging offers no remote access", () => {
  it("says so, and refuses the rest", async () => {
    const ctx = node();
    expect(await (await call(ctx, "GET", "/api/node/remote-access")).json()).toEqual({ available: false });
    for (const path of ["/api/node/remote-access/enable", "/api/node/remote-access/disable"]) {
      const res = await call(ctx, "POST", path, { accept_ca_terms: true, code: "7K2M-9QXD-4TZB-H8PN" });
      expect(res.status, path).toBe(409);
      expect(await res.json(), path).toEqual({ error: "Remote access isn't set up in this node's packaging.", code: "unavailable" });
    }
  });
});

describe("GET /api/node/remote-access", () => {
  it("answers the service's status", async () => {
    expect(await (await call(node(remoteAccess()), "GET", "/api/node/remote-access")).json()).toEqual(ON);
  });

  it("is for people who administer the node, not their agents", async () => {
    const res = await call(node(remoteAccess(), true), "GET", "/api/node/remote-access");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "agents cannot manage remote access" });
    vi.mocked(isNodeAdminAlias).mockResolvedValueOnce(false);
    expect((await call(node(remoteAccess()), "GET", "/api/node/remote-access")).status).toBe(403);
  });

  it("answers another method with 405", async () => {
    expect((await call(node(remoteAccess()), "DELETE", "/api/node/remote-access")).status).toBe(405);
    expect((await call(node(remoteAccess()), "GET", "/api/node/remote-access/enable")).status).toBe(405);
  });
});

describe("POST /api/node/remote-access/enable", () => {
  it("needs the CA's subscriber agreement accepted", async () => {
    const remote = remoteAccess();
    for (const body of [{ code: "7K2M-9QXD-4TZB-H8PN" }, { code: "7K2M-9QXD-4TZB-H8PN", accept_ca_terms: "yes" }]) {
      const res = await call(node(remote), "POST", "/api/node/remote-access/enable", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "accept the certificate authority's subscriber agreement to turn this on" });
    }
    expect(remote.enable).not.toHaveBeenCalled();
  });

  it("turns it on as the person asking, and records it without the code", async () => {
    audit.mockClear();
    const remote = remoteAccess();
    const res = await call(node(remote), "POST", "/api/node/remote-access/enable", { code: "7K2M-9QXD-4TZB-H8PN", accept_ca_terms: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ON);
    expect(remote.enable).toHaveBeenCalledWith({ code: "7K2M-9QXD-4TZB-H8PN", acceptCaTerms: true, by: "admin-1" });
    expect(audit).toHaveBeenCalledTimes(1);
    const [, row] = audit.mock.calls[0]!;
    expect(row).toEqual({
      action: "node.remote_access.enable",
      targetKind: "node",
      targetId: "https://stuga.test",
      detail: { id: "k7f3q2", hostname: "k7f3q2.mystuga.com", via: "enroll", ca_terms_accepted_at: "2026-10-02T00:13:10.000Z" },
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("7K2M");
  });

  it("turns it on again without a code", async () => {
    const remote = remoteAccess({ enable: vi.fn(async () => ({ status: ON, via: "resume" as const })) });
    await call(node(remote), "POST", "/api/node/remote-access/enable", { accept_ca_terms: true, code: "  " });
    expect(remote.enable).toHaveBeenCalledWith({ acceptCaTerms: true, by: "admin-1" });
  });

  it("answers a refusal with its status, sentence and code", async () => {
    const remote = remoteAccess({
      enable: vi.fn(async () => {
        throw new RemoteAccessRefusal(400, "enroll_code_used", "That code has already been used.");
      }),
    });
    const res = await call(node(remote), "POST", "/api/node/remote-access/enable", { code: "7K2M-9QXD-4TZB-H8PN", accept_ca_terms: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That code has already been used.", code: "enroll_code_used" });
  });

  it("is not for agents", async () => {
    const remote = remoteAccess();
    const res = await call(node(remote, true), "POST", "/api/node/remote-access/enable", { accept_ca_terms: true });
    expect(res.status).toBe(403);
    expect(remote.enable).not.toHaveBeenCalled();
  });
});

describe("POST /api/node/remote-access/disable", () => {
  it("turns it off and records which address", async () => {
    audit.mockClear();
    const remote = remoteAccess();
    const res = await call(node(remote), "POST", "/api/node/remote-access/disable");
    expect(await res.json()).toMatchObject({ enabled: false, state: "off" });
    expect(remote.disable).toHaveBeenCalledWith("admin-1");
    expect(audit.mock.calls[0]![1]).toEqual({
      action: "node.remote_access.disable",
      targetKind: "node",
      targetId: "https://stuga.test",
      detail: { id: "k7f3q2" },
    });
  });
});
