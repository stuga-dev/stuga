import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_EXPORT_COLUMNS, CSV_BOM } from "@stuga/protocol/domain/audit";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  auditEventsCursor: vi.fn(),
  getMemberRole: vi.fn(),
}));

const { auditEventsCursor, getMemberRole } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockCursor = auditEventsCursor as unknown as ReturnType<typeof vi.fn>;
const mockRole = getMemberRole as unknown as ReturnType<typeof vi.fn>;
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

/** One batch, then the end, as a server-side cursor yields. */
function batches(...pages: Record<string, unknown>[][]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < pages.length ? { done: false, value: pages[i++]! } : { done: true, value: undefined }),
      };
    },
  };
}

const ROWS = [
  {
    id: 1,
    at: new Date("2026-09-01T10:00:00.000Z"),
    actor: "owner-1",
    actor_kind: "human",
    on_behalf_of: null,
    source: "web",
    action: "acl.set",
    target_kind: "doc",
    target_id: "d1",
    target_label: "=cmd|' /c calc'!A1",
    status: "ok",
    request_id: "abc123",
    detail: { added: ["user:bob"] },
  },
  {
    id: 2,
    at: new Date("2026-09-01T11:00:00.000Z"),
    actor: "owner-1",
    actor_kind: "human",
    on_behalf_of: null,
    source: "web",
    action: "access.denied",
    target_kind: "route",
    target_id: "/api/audit",
    target_label: null,
    status: "denied",
    request_id: "def456",
    detail: { http_status: 403 },
  },
];

async function exportRequest(ctx: Ctx, qs: string): Promise<Response> {
  const url = new URL(`https://node.test/api/audit/export${qs}`);
  return routeWorkspaceRequest(ctx, new Request(url));
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** The body with its BOM intact: `Response.text()` strips a leading BOM. */
async function rawBody(res: Response): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCursor.mockReturnValue(batches(ROWS));
  mockRole.mockResolvedValue("owner");
});

describe("the CSV export", () => {
  it("leads with the BOM and the shared column list, and joins rows with CRLF", async () => {
    const res = await exportRequest(ctxFor(), "?format=csv");
    expect(res.status).toBe(200);
    const body = await rawBody(res);

    expect(body.startsWith(CSV_BOM)).toBe(true);
    const lines = body.slice(CSV_BOM.length).split("\r\n");
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.join(","));
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(body.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("neutralises a title a spreadsheet would run", async () => {
    const body = await rawBody(await exportRequest(ctxFor(), "?format=csv"));
    expect(body).toContain(`"'=cmd|' /c calc'!A1"`);
  });

  it("writes `at` as an ISO instant, not the driver's Date", async () => {
    const body = await rawBody(await exportRequest(ctxFor(), "?format=csv"));
    const cells = body.slice(CSV_BOM.length).split("\r\n")[1]!.split(",");
    const at = cells[AUDIT_EXPORT_COLUMNS.indexOf("at")]!;
    // Not the host-locale string `String(date)` would give.
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(at).toBe("2026-09-01T10:00:00.000Z");
  });

  it("agrees with the NDJSON of the same rows, column for column", async () => {
    const csv = await rawBody(await exportRequest(ctxFor(), "?format=csv"));
    const ndjson = await rawBody(await exportRequest(ctxFor(), "?format=ndjson"));
    const cells = csv.slice(CSV_BOM.length).split("\r\n")[1]!.split(",");
    const row = JSON.parse(ndjson.split("\n")[0]!) as Record<string, unknown>;
    for (const [i, column] of AUDIT_EXPORT_COLUMNS.entries()) {
      const cell = cells[i]!;
      if (cell.startsWith('"')) continue;
      expect([column, cell]).toEqual([column, row[column] === null ? "" : String(row[column])]);
    }
  });

  it("downloads under the shared name", async () => {
    const res = await exportRequest(ctxFor(), "?format=csv");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="stuga-audit-${stamp()}.csv"`);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });
});

describe("the NDJSON export", () => {
  it("carries no byte-order mark — it is parsed by programs, not by Excel", async () => {
    const res = await exportRequest(ctxFor(), "?format=ndjson");
    const body = await rawBody(res);
    expect(body.startsWith(CSV_BOM)).toBe(false);
    expect(body).not.toContain("\r\n");
    const lines = body.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).target_label).toBe("=cmd|' /c calc'!A1");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="stuga-audit-${stamp()}.ndjson"`);
  });
});

describe("the export's filters", () => {
  it("narrows to refusals", async () => {
    await exportRequest(ctxFor(), "?format=csv&status=denied");
    expect(mockCursor).toHaveBeenCalledWith({}, expect.objectContaining({ status: "denied" }));
  });

  it("narrows to a person, to an instrument, or to both at once", async () => {
    await exportRequest(ctxFor(), "?format=csv&principal=ada");
    expect(mockCursor).toHaveBeenLastCalledWith({}, expect.objectContaining({ principal: "ada", actor: undefined }));
    await exportRequest(ctxFor(), "?format=csv&principal=ada&actor=claude-connector");
    expect(mockCursor).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ principal: "ada", actor: "claude-connector" }),
    );
  });

  it("refuses a status outside the vocabulary instead of streaming an empty file", async () => {
    const res = await exportRequest(ctxFor(), "?format=csv&status=whatever");
    expect(res.status).toBe(400);
    expect(mockCursor).not.toHaveBeenCalled();
  });

  it("records the export, and says what was narrowed", async () => {
    await exportRequest(ctxFor(), "?format=csv&status=denied&principal=ada&action=doc.propose");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "audit.export",
        detail: {
          format: "csv",
          scope: {
            actor: null,
            principal: "ada",
            action: "doc.propose",
            target_kind: null,
            target_id: null,
            status: "denied",
            since: null,
            until: null,
          },
        },
      }),
    );
  });

  it("records an unnarrowed export as the whole ledger it is", async () => {
    await exportRequest(ctxFor(), "?format=ndjson");
    const [message] = send.mock.calls.at(-1) as [{ detail: { scope: Record<string, unknown> } }];
    expect(Object.values(message.detail.scope).every((v) => v === null)).toBe(true);
  });
});

describe("the export's gate", () => {
  it("refuses agents and non-admins", async () => {
    expect((await exportRequest(ctxFor({ isAgent: true, onBehalfOf: "owner-1" }), "?format=csv")).status).toBe(403);
    mockRole.mockResolvedValueOnce("member");
    expect((await exportRequest(ctxFor(), "?format=csv")).status).toBe(403);
    expect(mockCursor).not.toHaveBeenCalled();
  });

  it("reads the role live, as the list does — a context that still says owner is not enough", async () => {
    mockRole.mockResolvedValueOnce("member");
    const res = await exportRequest(ctxFor({ role: "owner" }), "?format=csv");
    expect(res.status).toBe(403);
    expect(mockRole).toHaveBeenCalledWith({}, "ws1", "owner-1");
  });

  it("refuses agents before the role is even read", async () => {
    await exportRequest(ctxFor({ isAgent: true, onBehalfOf: "owner-1" }), "?format=csv");
    expect(mockRole).not.toHaveBeenCalled();
  });
});

describe("what the export row names", () => {
  it("carries the request it was written inside", async () => {
    await exportRequest(ctxFor({ requestId: "req_42" }), "?format=csv");
    const [exported] = send.mock.calls.map(([m]) => m as Record<string, unknown>).filter((m) => m.action === "audit.export");
    expect(exported).toMatchObject({ requestId: "req_42" });
  });

  it("hands the query an ISO instant, not the caller's spelling of the window", async () => {
    await exportRequest(ctxFor(), "?format=csv&since=2026-08-01T00:00:00Z");
    expect(mockCursor).toHaveBeenCalledWith({}, expect.objectContaining({ since: "2026-08-01T00:00:00.000Z" }));
  });
});
