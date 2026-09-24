import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { insertAuditEvents, listAuditEvents, listNodeAuditEvents, auditFacets, purgeAuditEvents } from "./audit.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("audit events", () => {
  let sql: Sql;
  const WS = "ws-audit";

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE audit_events RESTART IDENTITY`;
  });

  const ev = (over: Partial<Parameters<typeof insertAuditEvents>[1][number]> = {}) => ({
    workspaceId: WS,
    actor: "user:alice",
    actorKind: "human" as const,
    source: "web" as const,
    action: "doc.update",
    targetKind: "doc",
    targetId: "d1",
    ...over,
  });

  it("appends a batch in one statement and reads it back newest first", async () => {
    await insertAuditEvents(sql, [
      ev({ at: new Date("2026-01-01T00:00:00Z"), requestId: "r1" }),
      ev({ at: new Date("2026-01-02T00:00:00Z"), action: "acl.set", detail: { added: ["user:bob"] } }),
      ev({ actorKind: "agent", actor: "agent:bot", onBehalfOf: "alice", source: "mcp", status: "error" }),
    ]);
    const rows = await listAuditEvents(sql, { workspaceId: WS });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ actor: "agent:bot", actor_kind: "agent", on_behalf_of: "alice", source: "mcp", status: "error" });
    expect(rows[1]).toMatchObject({ action: "acl.set", detail: { added: ["user:bob"] } });
    expect(rows[2]).toMatchObject({ request_id: "r1", detail: {} });
    expect(typeof rows[0]!.id).toBe("number");
    expect(rows[2]!.at).toBeInstanceOf(Date);
    expect(rows[2]!.at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(await listAuditEvents(sql, { workspaceId: "ws-other" })).toEqual([]);
  });

  it("filters by actor, action, target and time window", async () => {
    await insertAuditEvents(sql, [
      ev({ at: "2026-03-01T00:00:00Z", actor: "user:alice", action: "doc.update", targetId: "d1" }),
      ev({ at: "2026-03-02T00:00:00Z", actor: "user:bob", action: "doc.trash", targetId: "d2" }),
      ev({ at: "2026-03-03T00:00:00Z", actor: "user:alice", action: "member.remove", targetKind: "workspace", targetId: WS }),
    ]);
    const by = (f: Parameters<typeof listAuditEvents>[1]) => listAuditEvents(sql, f).then((r) => r.map((x) => x.action));
    expect(await by({ workspaceId: WS, actor: "user:alice" })).toEqual(["member.remove", "doc.update"]);
    expect(await by({ workspaceId: WS, action: "doc.trash" })).toEqual(["doc.trash"]);
    expect(await by({ workspaceId: WS, targetKind: "doc", targetId: "d2" })).toEqual(["doc.trash"]);
    expect(await by({ workspaceId: WS, since: "2026-03-02T00:00:00Z", until: "2026-03-03T00:00:00Z" })).toEqual(["doc.trash"]);
    expect(await by({ workspaceId: WS, limit: 1 })).toEqual(["member.remove"]);
  });

  it("finds a person through their agents by principal, and the agent alone by actor", async () => {
    await insertAuditEvents(sql, [
      ev({ at: "2026-07-01T00:00:00Z", actor: "user:alice", action: "doc.update" }),
      ev({ at: "2026-07-02T00:00:00Z", actor: "panel:user:alice", actorKind: "agent", onBehalfOf: "user:alice", action: "doc.coauthor" }),
      ev({ at: "2026-07-03T00:00:00Z", actor: "claude-connector", actorKind: "agent", onBehalfOf: "user:alice", source: "mcp", action: "doc.create" }),
      ev({ at: "2026-07-04T00:00:00Z", actor: "user:bob", action: "doc.trash" }),
      ev({ at: "2026-07-05T00:00:00Z", actor: "claude-connector", actorKind: "agent", onBehalfOf: "user:bob", source: "mcp", action: "doc.publish" }),
    ]);
    const by = (f: Parameters<typeof listAuditEvents>[1]) => listAuditEvents(sql, f).then((r) => r.map((x) => x.action));

    expect(await by({ workspaceId: WS, principal: "user:alice" })).toEqual(["doc.create", "doc.coauthor", "doc.update"]);
    expect(await by({ workspaceId: WS, principal: "user:bob" })).toEqual(["doc.publish", "doc.trash"]);

    expect(await by({ workspaceId: WS, actor: "claude-connector" })).toEqual(["doc.publish", "doc.create"]);
    expect(await by({ workspaceId: WS, actor: "user:alice" })).toEqual(["doc.update"]);

    expect(await by({ workspaceId: WS, principal: "user:alice", actor: "claude-connector" })).toEqual(["doc.create"]);
    expect(await by({ workspaceId: WS, principal: "user:bob", actor: "panel:user:alice" })).toEqual([]);
  });

  it("records the outcome and the target's name at write time, defaulting an unstated status to ok", async () => {
    await insertAuditEvents(sql, [
      ev({ at: "2026-04-01T00:00:00Z", targetLabel: "Q3 plan" }),
      ev({ at: "2026-04-02T00:00:00Z", action: "access.denied", status: "denied", targetKind: "route", targetId: "/api/keys", targetLabel: null }),
    ]);
    const rows = await listAuditEvents(sql, { workspaceId: WS });
    expect(rows[0]).toMatchObject({ action: "access.denied", status: "denied", target_label: null });
    expect(rows[1]).toMatchObject({ status: "ok", target_label: "Q3 plan" });
  });

  it("filters by status", async () => {
    await insertAuditEvents(sql, [
      ev({ at: "2026-04-01T00:00:00Z", action: "doc.update" }),
      ev({ at: "2026-04-02T00:00:00Z", action: "doc.write_rejected", status: "denied" }),
      ev({ at: "2026-04-03T00:00:00Z", action: "access.denied", status: "denied" }),
    ]);
    const by = (f: Parameters<typeof listAuditEvents>[1]) => listAuditEvents(sql, f).then((r) => r.map((x) => x.action));
    expect(await by({ workspaceId: WS, status: "denied" })).toEqual(["access.denied", "doc.write_rejected"]);
    expect(await by({ workspaceId: WS, status: "ok" })).toEqual(["doc.update"]);
    expect(await by({ workspaceId: WS, status: "nothing-writes-this" })).toEqual([]);
  });

  /** The cursor as a client sends it back: through JSON, where precision is lost. */
  const wireCursor = (row: { at: Date; id: number }) =>
    JSON.parse(JSON.stringify({ at: row.at, id: row.id })) as { at: string; id: number };

  /** Walk the ledger `size` rows at a time; every target_id in the order seen. */
  async function pageThrough(size: number): Promise<{ seen: string[]; pages: number }> {
    const seen: string[] = [];
    let before: { at: string; id: number } | undefined;
    let pages = 0;
    for (;;) {
      const page = await listAuditEvents(sql, { workspaceId: WS, limit: size, before });
      pages += 1;
      seen.push(...page.map((r) => r.target_id!));
      if (page.length < size) break;
      before = wireCursor(page.at(-1)!);
    }
    return { seen, pages };
  }

  it("pages by keyset without skipping or repeating a row", async () => {
    await insertAuditEvents(sql, [
      ev({ at: "2026-05-01T00:00:00Z", targetId: "d1" }),
      ev({ at: "2026-05-02T00:00:00Z", targetId: "d2" }),
      ev({ at: "2026-05-03T00:00:00Z", targetId: "d3" }),
      ev({ at: "2026-05-03T00:00:00Z", targetId: "d4" }),
      ev({ at: "2026-05-04T00:00:00Z", targetId: "d5" }),
    ]);
    const { seen, pages } = await pageThrough(2);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(["d5", "d4", "d3", "d2", "d1"]);
  });

  it("pages across rows that share a millisecond without losing any", async () => {
    await insertAuditEvents(sql, [
      ev({ at: "2026-05-10T00:00:00.123001Z", targetId: "m1" }),
      ev({ at: "2026-05-10T00:00:00.123456Z", targetId: "m2" }),
      ev({ at: "2026-05-10T00:00:00.123789Z", targetId: "m3" }),
      ev({ at: "2026-05-10T00:00:00.124000Z", targetId: "m4" }),
    ]);

    const stored = await listAuditEvents(sql, { workspaceId: WS });
    expect(stored.map((r) => r.at.toISOString())).toEqual([
      "2026-05-10T00:00:00.124Z",
      "2026-05-10T00:00:00.123Z",
      "2026-05-10T00:00:00.123Z",
      "2026-05-10T00:00:00.123Z",
    ]);

    const { seen } = await pageThrough(1);
    expect(seen).toEqual(["m4", "m3", "m2", "m1"]);
  });

  it("refuses a row whose timestamp a millisecond cursor could not name", async () => {
    await expect(
      sql`INSERT INTO audit_events (at, workspace_id, actor, actor_kind, source, action)
          VALUES ('2026-05-10T00:00:00.123456Z'::timestamptz, ${WS}, 'u_x', 'human', 'web', 'doc.recover')`,
    ).rejects.toThrow(/audit_events_at_ms_check/);
  });

  it("summarises the window the reader is looking at, not the page they loaded", async () => {
    await insertAuditEvents(sql, [
      ev({ at: "2026-06-01T00:00:00Z", actor: "user:alice", action: "doc.update" }),
      ev({ at: "2026-06-02T00:00:00Z", actor: "user:alice", action: "doc.update" }),
      ev({ at: "2026-06-03T00:00:00Z", actor: "user:bob", action: "acl.set", status: "denied" }),
      ev({ at: "2026-06-09T00:00:00Z", actor: "user:carol", action: "doc.trash" }),
      { ...ev({ at: "2026-06-02T00:00:00Z", actor: "user:mallory" }), workspaceId: "ws-other" },
    ]);

    const all = await auditFacets(sql, { workspaceId: WS });
    expect(all.principals.map((f) => [f.value, f.count])).toEqual([
      ["user:alice", 2],
      ["user:bob", 1],
      ["user:carol", 1],
    ]);
    expect(all.actions.map((f) => f.value)).toEqual(["doc.update", "acl.set", "doc.trash"]);
    expect(all.statuses.map((f) => [f.value, f.count])).toEqual([
      ["ok", 3],
      ["denied", 1],
    ]);
    expect(all.truncated).toBe(false);
    expect(all.principals[0]!.last_at.toISOString()).toBe("2026-06-02T00:00:00.000Z");
    expect(all.principals.some((f) => f.value === "user:mallory")).toBe(false);
    expect(all.agents).toEqual([]);

    const window = await auditFacets(sql, { workspaceId: WS, since: "2026-06-02T00:00:00Z", until: "2026-06-04T00:00:00Z" });
    expect(window.principals.map((f) => f.value)).toEqual(["user:alice", "user:bob"]);

    const cut = await auditFacets(sql, { workspaceId: WS, limit: 2 });
    expect(cut.principals).toHaveLength(2);
    expect(cut.truncated).toBe(true);
  });

  it("counts an agent's row toward the human it acted for and toward itself", async () => {
    await insertAuditEvents(sql, [
      ev({ at: "2026-07-11T00:00:00Z", actor: "user:alice", action: "doc.update" }),
      ev({ at: "2026-07-12T00:00:00Z", actor: "panel:user:alice", actorKind: "agent", onBehalfOf: "user:alice", action: "doc.coauthor" }),
      ev({ at: "2026-07-13T00:00:00Z", actor: "claude-connector", actorKind: "agent", onBehalfOf: "user:alice", source: "mcp", action: "doc.create" }),
      ev({ at: "2026-07-14T00:00:00Z", actor: "user:bob", action: "doc.trash" }),
    ]);

    const f = await auditFacets(sql, { workspaceId: WS });
    expect(f.principals.map((x) => [x.value, x.count])).toEqual([
      ["user:alice", 3],
      ["user:bob", 1],
    ]);
    expect(f.agents.map((x) => [x.value, x.count])).toEqual([
      ["claude-connector", 1],
      ["panel:user:alice", 1],
    ]);
    expect(f.principals.some((x) => x.value === "panel:user:alice")).toBe(false);
    expect(f.principals[0]!.last_at.toISOString()).toBe("2026-07-13T00:00:00.000Z");

    // One flag for every axis: here only the agents axis is cut short.
    const cut = await auditFacets(sql, {
      workspaceId: WS,
      since: "2026-07-11T00:00:00Z",
      until: "2026-07-14T00:00:00Z",
      limit: 1,
    });
    expect(cut.principals.map((x) => x.value)).toEqual(["user:alice"]);
    expect(cut.agents.map((x) => x.value)).toEqual(["claude-connector"]);
    expect(cut.truncated).toBe(true);
  });

  it("is a no-op for an empty batch and purges by age", async () => {
    await insertAuditEvents(sql, []);
    await insertAuditEvents(sql, [ev({ at: new Date(Date.now() - 100 * 86400_000) }), ev()]);
    expect(await purgeAuditEvents(sql, 90)).toBe(1);
    expect(await listAuditEvents(sql, { workspaceId: WS })).toHaveLength(1);
  });

  it("counts a purge in SQL: nothing to remove is zero, and a batch is its size", async () => {
    expect(await purgeAuditEvents(sql, 90)).toBe(0);
    const old = new Date(Date.now() - 100 * 86400_000);
    await insertAuditEvents(sql, Array.from({ length: 7 }, (_, i) => ev({ at: new Date(old.getTime() + i * 1000) })));
    expect(await purgeAuditEvents(sql, 90)).toBe(7);
    expect(await purgeAuditEvents(sql, 90)).toBe(0);
  });

  it("pages the node's own rows by keyset, newest first, and leaves the tenants' rows alone", async () => {
    const node = (i: number, over: Partial<Parameters<typeof insertAuditEvents>[1][number]> = {}) =>
      ev({
        workspaceId: null,
        action: "node.settings.update",
        targetKind: "node",
        targetId: "settings",
        at: new Date(`2026-03-0${i}T00:00:00Z`),
        ...over,
      });
    await insertAuditEvents(sql, [
      node(1),
      node(2),
      node(3),
      node(3, { action: "node.admins.grant" }),
      ev({ at: new Date("2026-03-09T00:00:00Z") }),
      ev({ workspaceId: null, action: "doc.update", at: new Date("2026-03-09T00:00:00Z") }),
    ]);
    const first = await listNodeAuditEvents(sql, { limit: 2 });
    expect(first.map((r) => [r.action, r.at.toISOString()])).toEqual([
      ["node.admins.grant", "2026-03-03T00:00:00.000Z"],
      ["node.settings.update", "2026-03-03T00:00:00.000Z"],
    ]);
    const last = first[first.length - 1]!;
    const second = await listNodeAuditEvents(sql, { limit: 2, before: { at: last.at, id: last.id } });
    expect(second.map((r) => r.at.toISOString())).toEqual(["2026-03-02T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
    const rest = second[second.length - 1]!;
    expect(await listNodeAuditEvents(sql, { limit: 2, before: { at: rest.at, id: rest.id } })).toEqual([]);
    expect((await listNodeAuditEvents(sql)).map((r) => r.action)).toHaveLength(4);
  });
});
