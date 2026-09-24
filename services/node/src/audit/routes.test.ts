import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getMemberRole: vi.fn(),
  listAuditEvents: vi.fn(),
  auditFacets: vi.fn(),
}));

const { getMemberRole, listAuditEvents, auditFacets } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockRole = getMemberRole as unknown as ReturnType<typeof vi.fn>;
const mockList = listAuditEvents as unknown as ReturnType<typeof vi.fn>;
const mockFacets = auditFacets as unknown as ReturnType<typeof vi.fn>;

/** The job queue the ledger writes go to. */
const send = vi.fn(async (_message: unknown) => {});

function ctxFor(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "owner-1",
    displayName: "Ada",
    isAgent: false,
    principals: ["user:owner-1", "org:ws1"],
    workspaceId: "ws1",
    role: "owner",
    env: { jobs: { send } },
    ...over,
  } as unknown as Ctx;
}

async function get(ctx: Ctx, qs = ""): Promise<Response> {
  const url = new URL(`https://node.test/api/audit${qs}`);
  return routeWorkspaceRequest(ctx, new Request(url));
}

async function facets(ctx: Ctx, qs = ""): Promise<Response> {
  const url = new URL(`https://node.test/api/audit/facets${qs}`);
  return routeWorkspaceRequest(ctx, new Request(url));
}

/** One row as the query hands it back: `at` is a Date, `id` a bigserial. */
const row = (id: number, at: string) => ({ id, at: new Date(at), action: "acl.set", actor: "owner-1" });

/** The audit messages this request enqueued. */
const auditMessages = () => send.mock.calls.map(([m]) => m as Record<string, unknown>);

/** The dedup window is process-wide, so each case starts a window after the last one's. */
let clock = Date.now();
const advancePastWindow = () => {
  clock += 120_000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockResolvedValue("owner");
  mockList.mockResolvedValue([]);
  mockFacets.mockResolvedValue({ principals: [], agents: [], actions: [], statuses: [], truncated: false });
  advancePastWindow();
});

describe("GET /api/audit", () => {
  it("returns the workspace's events, tenant-scoped from ctx alone", async () => {
    const rows = [{ id: 1, action: "acl.set", actor: "owner-1" }];
    mockList.mockResolvedValue(rows);
    const res = await get(ctxFor());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: rows, next_before: null });
    expect(mockList).toHaveBeenCalledWith({}, expect.objectContaining({ workspaceId: "ws1" }));
  });

  it("passes every filter through and clamps the limit to 500", async () => {
    await get(
      ctxFor(),
      "?actor=bob&principal=ada&action=acl.set&target_kind=doc&target_id=d1&status=denied" +
        "&since=2026-08-01T00:00:00Z&until=2026-08-20T00:00:00Z&limit=9001",
    );
    expect(mockList).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "ws1",
        actor: "bob",
        principal: "ada",
        action: "acl.set",
        targetKind: "doc",
        targetId: "d1",
        status: "denied",
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-20T00:00:00.000Z",
        before: undefined,
        limit: 500,
      },
    );
  });

  it("hands the query an ISO instant whatever spelling the caller used", async () => {
    await get(ctxFor(), "?since=" + encodeURIComponent("Sat, 01 Aug 2026 00:00:00 GMT"));
    expect(mockList).toHaveBeenCalledWith({}, expect.objectContaining({ since: "2026-08-01T00:00:00.000Z" }));
  });

  it("refuses a malformed since/until instead of querying with garbage", async () => {
    for (const qs of ["?since=not-a-date", "?until=yesterdayish"]) {
      expect((await get(ctxFor(), qs)).status).toBe(400);
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  it("is owner/admin only, by the role read live", async () => {
    mockRole.mockResolvedValue("member");
    const res = await get(ctxFor());
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("admits an admin", async () => {
    mockRole.mockResolvedValue("admin");
    expect((await get(ctxFor({ alias: "adm", role: "admin" }))).status).toBe(200);
  });

  it("refuses agents before the role is even read", async () => {
    const res = await get(ctxFor({ isAgent: true, onBehalfOf: "owner-1" }));
    expect(res.status).toBe(403);
    expect(mockRole).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("the two ways to name a person", () => {
  it("passes a principal down as its own filter, leaving actor exact", async () => {
    await get(ctxFor(), "?principal=ada");
    expect(mockList).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ principal: "ada", actor: undefined }),
    );
  });

  it("sends both together — one person, narrowed to one instrument", async () => {
    await get(ctxFor(), "?principal=ada&actor=claude-connector");
    expect(mockList).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ principal: "ada", actor: "claude-connector" }),
    );
  });

  it("takes a name it has never seen: the ledger holds no roster to check one against", async () => {
    const res = await get(ctxFor(), "?principal=nobody-in-particular");
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith({}, expect.objectContaining({ principal: "nobody-in-particular" }));
  });

  it("names the principal in the audit.read row, beside the actor", async () => {
    await get(ctxFor(), "?principal=ada&actor=claude-connector");
    const reads = auditMessages().filter((m) => m.action === "audit.read");
    expect(reads[0]).toMatchObject({
      detail: { opened_with: { principal: "ada", actor: "claude-connector" } },
    });
  });
});

describe("the status filter", () => {
  it("refuses a value outside the vocabulary rather than querying for it", async () => {
    const res = await get(ctxFor(), "?status=maybe");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("status must be one of");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("accepts both spellings the ledger can hold", async () => {
    for (const status of ["ok", "denied"]) {
      expect((await get(ctxFor(), `?status=${status}`)).status).toBe(200);
      expect(mockList).toHaveBeenLastCalledWith({}, expect.objectContaining({ status }));
    }
  });
});

describe("the keyset cursor", () => {
  it("refuses half a cursor: `at` alone cannot order rows a batch insert shares", async () => {
    for (const qs of ["?before_at=2026-08-01T00:00:00Z", "?before_id=42"]) {
      const res = await get(ctxFor(), qs);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("before_at and before_id go together");
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  it("refuses a before_at that is not a timestamp and a before_id that is not a row id", async () => {
    const bad = await get(ctxFor(), "?before_at=lunchtime&before_id=42");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("before_at must be a timestamp");
    for (const id of ["abc", "0", "-3", "1.5"]) {
      const res = await get(ctxFor(), `?before_at=2026-08-01T00:00:00Z&before_id=${id}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("before_id must be a row id");
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  it("passes a whole cursor down as one position", async () => {
    await get(ctxFor(), "?before_at=2026-08-01T00:00:00Z&before_id=42");
    expect(mockList).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ before: { at: "2026-08-01T00:00:00.000Z", id: 42 } }),
    );
  });

  it("offers next_before only when the page came back full", async () => {
    mockList.mockResolvedValue([row(9, "2026-09-02T10:00:00.000Z"), row(8, "2026-09-01T10:00:00.000Z")]);
    const full = await (await get(ctxFor(), "?limit=2")).json();
    expect(full.next_before).toEqual({ at: "2026-09-01T10:00:00.000Z", id: 8 });

    mockList.mockResolvedValue([row(9, "2026-09-02T10:00:00.000Z")]);
    const short = await (await get(ctxFor(), "?limit=2")).json();
    expect(short.next_before).toBeNull();
  });
});

describe("reading the ledger is itself recorded", () => {
  it("writes exactly one audit.read row, carrying what the opening request asked for", async () => {
    await get(ctxFor(), "?actor=bob&status=denied&limit=25");
    const reads = auditMessages().filter((m) => m.action === "audit.read");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      kind: "audit",
      workspaceId: "ws1",
      actor: "owner-1",
      targetKind: "workspace",
      targetId: "ws1",
      detail: { dedup_window_ms: 60_000, opened_with: { actor: "bob", status: "denied", limit: 25, paged: false } },
    });
  });

  it("stamps the row with the time of the read, not the time the worker gets to it", async () => {
    const now = Date.now();
    await get(ctxFor(), "");
    const [read] = auditMessages().filter((m) => m.action === "audit.read");
    expect(read?.at).toBe(new Date(now).toISOString());
  });

  it("names the request it was written inside, so a row and a response header meet", async () => {
    await get(ctxFor({ requestId: "req_7" }), "");
    const [read] = auditMessages().filter((m) => m.action === "audit.read");
    expect(read).toMatchObject({ requestId: "req_7" });
  });

  it("marks a paged read as paged, so a page-two fetch is not mistaken for a fresh look", async () => {
    await get(ctxFor(), "?before_at=2026-08-01T00:00:00Z&before_id=42");
    expect(auditMessages()[0]).toMatchObject({ action: "audit.read", detail: { opened_with: { paged: true } } });
  });

  it("records nothing when the read was refused", async () => {
    mockRole.mockResolvedValue("member");
    await get(ctxFor());
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the read's dedup window", () => {
  const reads = () => auditMessages().filter((m) => m.action === "audit.read");

  it("writes one row for a repeated read, and says what that row covers", async () => {
    for (let i = 0; i < 4; i++) await get(ctxFor(), "?actor=bob&status=denied");
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toMatchObject({ detail: { dedup_window_ms: 60_000 } });
  });

  it("does not spend a row per page: the cursor is not part of the key", async () => {
    await get(ctxFor(), "?actor=bob");
    await get(ctxFor(), "?actor=bob&before_at=2026-08-01T00:00:00Z&before_id=42");
    await get(ctxFor(), "?actor=bob&before_at=2026-07-01T00:00:00Z&before_id=17");
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toMatchObject({ detail: { opened_with: { paged: false } } });
  });

  it("does not spend a row on a moving `since`: the same view re-fetched is one look", async () => {
    const day = 86_400_000;
    for (const tick of [0, 300, 900]) {
      await get(ctxFor(), `?since=${new Date(clock + tick - day).toISOString()}`);
    }
    expect(reads()).toHaveLength(1);
  });

  it("covers a reader flicking filter menus, and claims no more than that", async () => {
    await get(ctxFor(), "?actor=bob");
    await get(ctxFor(), "?actor=carol");
    await get(ctxFor(), "?actor=bob&status=denied");
    expect(reads()).toHaveLength(1);
    expect(reads()[0]!.detail).toEqual({
      dedup_window_ms: 60_000,
      opened_with: {
        actor: "bob",
        principal: undefined,
        action: undefined,
        target_kind: undefined,
        target_id: undefined,
        status: undefined,
        since: undefined,
        until: undefined,
        limit: 100,
        paged: false,
      },
    });
  });

  it("records the same read again once the window has passed", async () => {
    await get(ctxFor(), "?actor=bob");
    expect(reads()).toHaveLength(1);
    advancePastWindow();
    await get(ctxFor(), "?actor=bob");
    expect(reads()).toHaveLength(2);
  });

  it("keeps two readers apart: the alias is in the key", async () => {
    await get(ctxFor(), "?actor=bob");
    await get(ctxFor({ alias: "adm", role: "admin" }), "?actor=bob");
    expect(reads().map((m) => m.actor)).toEqual(["owner-1", "adm"]);
  });
});

describe("GET /api/audit/facets", () => {
  it("answers with the four axes, last_at as ISO", async () => {
    mockFacets.mockResolvedValue({
      principals: [{ value: "owner-1", count: 12, last_at: new Date("2026-09-02T10:00:00.000Z") }],
      agents: [{ value: "panel:owner-1", count: 4, last_at: new Date("2026-09-02T10:00:00.000Z") }],
      actions: [{ value: "acl.set", count: 5, last_at: new Date("2026-09-01T10:00:00.000Z") }],
      statuses: [{ value: "denied", count: 2, last_at: new Date("2026-09-02T09:00:00.000Z") }],
      truncated: true,
    });
    const res = await facets(ctxFor(), "?since=2026-08-01T00:00:00Z&until=2026-09-03T00:00:00Z");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principals: [{ value: "owner-1", count: 12, last_at: "2026-09-02T10:00:00.000Z" }],
      agents: [{ value: "panel:owner-1", count: 4, last_at: "2026-09-02T10:00:00.000Z" }],
      actions: [{ value: "acl.set", count: 5, last_at: "2026-09-01T10:00:00.000Z" }],
      statuses: [{ value: "denied", count: 2, last_at: "2026-09-02T09:00:00.000Z" }],
      truncated: true,
    });
    expect(mockFacets).toHaveBeenCalledWith(
      {},
      { workspaceId: "ws1", since: "2026-08-01T00:00:00.000Z", until: "2026-09-03T00:00:00.000Z" },
    );
  });

  it("carries the list's gate: agents never, members no", async () => {
    expect((await facets(ctxFor({ isAgent: true, onBehalfOf: "owner-1" }))).status).toBe(403);
    expect(mockFacets).not.toHaveBeenCalled();
    mockRole.mockResolvedValue("member");
    expect((await facets(ctxFor())).status).toBe(403);
    expect(mockFacets).not.toHaveBeenCalled();
  });

  it("takes no status: a menu narrowed by the filter it feeds could not widen it again", async () => {
    await facets(ctxFor(), "?status=denied");
    expect(mockFacets).toHaveBeenCalledWith({}, expect.not.objectContaining({ status: expect.anything() }));
  });

  it("is not recorded: it belongs to the same page load as audit.read", async () => {
    await facets(ctxFor());
    expect(send).not.toHaveBeenCalled();
  });
});
