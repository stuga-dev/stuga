import { describe, expect, it } from "vitest";
import { AUDIT_PAGE_CAP, nextAuditCursor, parseAuditCursor, parseAuditFilters, parseAuditLimit } from "./read.js";

const params = (qs: string) => new URL(`https://node.test/api/audit${qs}`).searchParams;

describe("parseAuditFilters", () => {
  it("reads every filter, and turns an empty parameter into an absent one", () => {
    const parsed = parseAuditFilters(
      params("?actor=bob&principal=ada&action=acl.set&target_kind=doc&target_id=d1&status=denied&until="),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        actor: "bob",
        principal: "ada",
        action: "acl.set",
        targetKind: "doc",
        targetId: "d1",
        status: "denied",
        since: undefined,
        until: undefined,
      },
    });
  });

  it("normalises a window to ISO instants", () => {
    const parsed = parseAuditFilters(params("?since=2026-08-01T00:00:00Z&until=2026-08-20T12:00:00%2B02:00"));
    expect(parsed).toMatchObject({ ok: true, value: { since: "2026-08-01T00:00:00.000Z", until: "2026-08-20T10:00:00.000Z" } });
  });

  it("refuses a window it cannot read, naming the parameter", () => {
    expect(parseAuditFilters(params("?since=not-a-date"))).toEqual({ ok: false, message: "since must be a timestamp" });
    expect(parseAuditFilters(params("?until=yesterdayish"))).toEqual({ ok: false, message: "until must be a timestamp" });
  });

  it("refuses a status outside the vocabulary", () => {
    expect(parseAuditFilters(params("?status=pending"))).toEqual({ ok: false, message: "status must be one of: ok, denied" });
  });
});

describe("parseAuditCursor", () => {
  it("is nothing when the caller asked for the newest page", () => {
    expect(parseAuditCursor(params(""))).toEqual({ ok: true, value: undefined });
  });

  it("is one position, normalised", () => {
    expect(parseAuditCursor(params("?before_at=2026-08-01T00:00:00Z&before_id=42"))).toEqual({
      ok: true,
      value: { at: "2026-08-01T00:00:00.000Z", id: 42 },
    });
  });

  it("refuses half a cursor, an unreadable instant, and an id that is not a row's", () => {
    expect(parseAuditCursor(params("?before_at=2026-08-01T00:00:00Z"))).toEqual({
      ok: false,
      message: "before_at and before_id go together",
    });
    expect(parseAuditCursor(params("?before_id=42"))).toEqual({ ok: false, message: "before_at and before_id go together" });
    expect(parseAuditCursor(params("?before_at=lunchtime&before_id=42"))).toEqual({
      ok: false,
      message: "before_at must be a timestamp",
    });
    for (const id of ["0", "-3", "4.5", "abc"]) {
      expect(parseAuditCursor(params(`?before_at=2026-08-01T00:00:00Z&before_id=${id}`))).toEqual({
        ok: false,
        message: "before_id must be a row id",
      });
    }
  });
});

describe("parseAuditLimit", () => {
  it("falls back for an absent, zero or unreadable limit and clamps the rest", () => {
    expect(parseAuditLimit(params(""), 100)).toBe(100);
    expect(parseAuditLimit(params("?limit=0"), 100)).toBe(100);
    expect(parseAuditLimit(params("?limit=lots"), 100)).toBe(100);
    expect(parseAuditLimit(params("?limit=25.9"), 100)).toBe(25);
    expect(parseAuditLimit(params("?limit=9001"), 100)).toBe(AUDIT_PAGE_CAP);
  });
});

describe("nextAuditCursor", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 10 - i, at: new Date(2026, 8, 1, 10, 0, 0, 0) }));

  it("offers the last row's position only when the page came back full", () => {
    expect(nextAuditCursor(rows(3), 3)).toEqual({ at: new Date(2026, 8, 1, 10, 0, 0, 0).toISOString(), id: 8 });
    expect(nextAuditCursor(rows(2), 3)).toBeNull();
    expect(nextAuditCursor([], 3)).toBeNull();
  });

  it("spells the position as the wire does, whatever the driver handed back", () => {
    expect(nextAuditCursor([{ id: "7", at: "2026-09-01T10:00:00Z" }], 1)).toEqual({ at: "2026-09-01T10:00:00.000Z", id: 7 });
  });
});
