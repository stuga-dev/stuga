// @vitest-environment jsdom
/** The audit requests as they leave the browser; AuditLog.test.tsx mocks this layer. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Audit } from "./audit";
import { Users } from "./users";

let calls: string[];

/** Enough of a Response for the fetch primitive. */
function answered(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    blob: async () => new Blob(["id,at\r\n"]),
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return answered({ events: [], next_before: null });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The query string the one request carried. */
function sent(): URLSearchParams {
  expect(calls, "no request was made").toHaveLength(1);
  return new URL(calls[0]!, "https://node.test").searchParams;
}

describe("Audit.list", () => {
  it("carries both halves of the keyset cursor, with the window and the page size", async () => {
    await Audit.list({
      limit: 200,
      since: "2026-08-06T00:00:00.000Z",
      before_at: "2026-09-05T08:00:00.000Z",
      before_id: 41,
    });
    const q = sent();
    expect(q.get("before_at")).toBe("2026-09-05T08:00:00.000Z");
    expect(q.get("before_id")).toBe("41");
    expect(q.get("limit")).toBe("200");
    expect(q.get("since")).toBe("2026-08-06T00:00:00.000Z");
  });

  it("sends neither half of a cursor when only one is offered", async () => {
    await Audit.list({ limit: 200, before_at: "2026-09-05T08:00:00.000Z" });
    const q = sent();
    expect(q.has("before_at")).toBe(false);
    expect(q.has("before_id")).toBe(false);
  });

  it("asks for the newest page with no cursor at all", async () => {
    await Audit.list({ limit: 200, actor: "u_liv", status: "denied" });
    const q = sent();
    expect(q.has("before_at")).toBe(false);
    expect(q.get("actor")).toBe("u_liv");
    expect(q.get("status")).toBe("denied");
  });

  it("sends the accountable principal under its own name", async () => {
    // Not as `actor`, which would drop rows an agent wrote on this person's behalf.
    await Audit.list({ limit: 200, principal: "u_liv" });
    const q = sent();
    expect(q.get("principal")).toBe("u_liv");
    expect(q.has("actor")).toBe(false);
  });

  it("carries the person and the instrument together, as two parameters", async () => {
    await Audit.list({ limit: 200, principal: "u_liv", actor: "agent:claude-connector" });
    const q = sent();
    expect(q.get("principal")).toBe("u_liv");
    expect(q.get("actor")).toBe("agent:claude-connector");
  });
});

describe("Audit.export", () => {
  it("carries the filters the reader narrowed to, and the format asked for", async () => {
    const { filename } = await Audit.export(
      {
        actor: "u_liv",
        action: "acl.set",
        status: "denied",
        since: "2026-08-06T00:00:00.000Z",
      },
      "csv",
    );
    const q = sent();
    expect(q.get("actor")).toBe("u_liv");
    expect(q.get("action")).toBe("acl.set");
    expect(q.get("status")).toBe("denied");
    expect(q.get("since")).toBe("2026-08-06T00:00:00.000Z");
    expect(q.get("format")).toBe("csv");
    // No content-disposition came back, so the client names the file.
    expect(filename).toMatch(/^stuga-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("carries the person filter, which is the one the reader is looking at", async () => {
    await Audit.export({ principal: "u_liv", actor: "agent:claude-connector" }, "csv");
    const q = sent();
    expect(q.get("principal")).toBe("u_liv");
    expect(q.get("actor")).toBe("agent:claude-connector");
  });
});

describe("Users.resolve", () => {
  it("splits more aliases than one request may carry, and merges the answers", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `u_${i}`);
    // Each request answers only what it asked for, so a dropped chunk loses names.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        const asked = new URL(String(url), "https://node.test").searchParams.get("ids")!.split(",");
        return answered({ users: asked.map((alias) => ({ alias, display_name: alias, email: null })) });
      }),
    );
    const { users } = await Users.resolve(ids);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      const asked = new URL(call, "https://node.test").searchParams.get("ids")!.split(",");
      // The node refuses more than 200 ids in one call.
      expect(asked.length).toBeLessThanOrEqual(200);
    }
    expect(users.map((u) => u.alias)).toEqual(ids);
  });

  it("asks nothing when there is nothing to ask about", async () => {
    const { users } = await Users.resolve([]);
    expect(calls).toEqual([]);
    expect(users).toEqual([]);
  });
});
