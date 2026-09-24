import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, deleteDoc, setDocAcl } from "./docs.js";
import { createFolder, setFolderAcl } from "./folders.js";
import {
  insertNotification,
  listNotifications,
  markNotificationsRead,
  purgeOldNotifications,
  unreadNotificationCount,
} from "./notifications.js";
import { listMembershipGroups, upsertGroup, addWorkspaceMember } from "./workspaces.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const WS = "ws-notif";
const OTHER_WS = "ws-notif-other";
const ALICE = ["user:alice", `org:${WS}`];
const BOB = ["user:bob", `org:${WS}`];

function only(ws: string, principals: string[]): Record<string, string[]> {
  return { [ws]: principals };
}

async function seedWorkspaces(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO workspaces (workspace_id, name)
    VALUES (${WS}, 'Acme'), (${OTHER_WS}, 'Side project'), ('ws-not-mine', 'Not mine')
    ON CONFLICT (workspace_id) DO NOTHING`;
}

function row(id: string, over: Partial<Parameters<typeof insertNotification>[1]> = {}) {
  return {
    id,
    workspace_id: WS,
    recipient_alias: "alice",
    event_type: "REQUEST_ACCESS",
    resource_id: null,
    resource_title: null,
    resource_url: null,
    actor_alias: null,
    payload: {},
    ...over,
  };
}

describe.skipIf(!URL)("notification read state and retention", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE notifications CASCADE`;
    await seedWorkspaces(sql);
  });

  it("mark-all flips only the caller's rows in the workspaces it is given", async () => {
    await insertNotification(sql, row("mine-1"));
    await insertNotification(sql, row("mine-2"));
    await insertNotification(sql, row("other-user", { recipient_alias: "bob" }));
    await insertNotification(sql, row("other-ws", { workspace_id: OTHER_WS }));
    await insertNotification(sql, row("null-ws", { workspace_id: null }));

    const updated = await markNotificationsRead(sql, "alice", [WS]);
    expect(updated).toBe(2);

    const mine = await listNotifications(sql, "alice", only(WS, ALICE));
    expect(mine.every((n) => n.read)).toBe(true);
    const bobs = await listNotifications(sql, "bob", only(WS, BOB));
    expect(bobs.map((n) => n.read)).toEqual([false]);
    const otherWs = await listNotifications(sql, "alice", only(OTHER_WS, ALICE));
    expect(otherWs.map((n) => n.read)).toEqual([false]);
  });

  it("id-scoped mark leaves the rest unread, and re-marking counts zero", async () => {
    await insertNotification(sql, row("a"));
    await insertNotification(sql, row("b"));
    await insertNotification(sql, row("c"));

    expect(await markNotificationsRead(sql, "alice", [WS], ["a", "b"])).toBe(2);
    expect(await markNotificationsRead(sql, "alice", [WS], ["a", "b"])).toBe(0);

    const rows = await listNotifications(sql, "alice", only(WS, ALICE));
    const byId = new Map(rows.map((n) => [n.id, n.read]));
    expect(byId.get("a")).toBe(true);
    expect(byId.get("b")).toBe(true);
    expect(byId.get("c")).toBe(false);
  });

  it("ids can't reach across the recipient fence", async () => {
    await insertNotification(sql, row("bobs-row", { recipient_alias: "bob" }));
    expect(await markNotificationsRead(sql, "alice", [WS], ["bobs-row"])).toBe(0);
    const bobs = await listNotifications(sql, "bob", only(WS, BOB));
    expect(bobs.map((n) => n.read)).toEqual([false]);
  });

  it("the unread count stops at the recipient and the reach it is given", async () => {
    await insertNotification(sql, row("u1"));
    await insertNotification(sql, row("u2"));
    await insertNotification(sql, row("already-read"));
    await insertNotification(sql, row("other-user", { recipient_alias: "bob" }));
    await insertNotification(sql, row("other-ws", { workspace_id: OTHER_WS }));
    await markNotificationsRead(sql, "alice", [WS], ["already-read"]);

    expect(await unreadNotificationCount(sql, "alice", only(WS, ALICE))).toBe(2);
    expect(await unreadNotificationCount(sql, "bob", only(WS, BOB))).toBe(1);
    expect(await unreadNotificationCount(sql, "alice", only(OTHER_WS, ALICE))).toBe(1);
    expect(await unreadNotificationCount(sql, "nobody", only(WS, ["user:nobody", `org:${WS}`]))).toBe(0);
  });

  it("a created_at watermark spares rows newer than what the client has seen", async () => {
    await insertNotification(sql, row("seen-1"));
    await insertNotification(sql, row("seen-2"));
    await insertNotification(sql, row("unseen-newer"));
    await sql`UPDATE notifications SET created_at = now() - interval '10 minutes' WHERE id IN ('seen-1', 'seen-2')`;
    // As the client holds it: through a Date, so microseconds are gone.
    const watermark = await sql<{ w: Date }[]>`SELECT created_at AS w FROM notifications WHERE id = 'seen-2'`;

    expect(await markNotificationsRead(sql, "alice", [WS], undefined, watermark[0]!.w.toISOString())).toBe(2);

    const rows = await listNotifications(sql, "alice", only(WS, ALICE));
    const byId = new Map(rows.map((n) => [n.id, n.read]));
    expect(byId.get("seen-1")).toBe(true);
    expect(byId.get("seen-2")).toBe(true);
    expect(byId.get("unseen-newer")).toBe(false);
  });

  it("retention deletes old rows, those without a workspace included, and spares fresh ones", async () => {
    await insertNotification(sql, row("fresh"));
    await insertNotification(sql, row("old"));
    await insertNotification(sql, row("old-null-ws", { workspace_id: null }));
    await sql`UPDATE notifications SET created_at = now() - interval '91 days' WHERE id IN ('old', 'old-null-ws')`;

    expect(await purgeOldNotifications(sql, 90)).toBe(2);

    const left = await sql<{ id: string }[]>`SELECT id FROM notifications`;
    expect(left.map((r) => r.id)).toEqual(["fresh"]);
  });
});

describe.skipIf(!URL)("a notification about the node itself", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE notifications CASCADE`;
    await seedWorkspaces(sql);
    await insertNotification(sql, row("in-ws"));
    await insertNotification(
      sql,
      row("about-node", { workspace_id: null, event_type: "SECURITY_UPDATE_AVAILABLE", resource_url: "https://n.test/settings/node/about" }),
    );
    await insertNotification(sql, row("bobs-node-row", { workspace_id: null, recipient_alias: "bob" }));
  });

  it("is listed and counted only for a caller who reads the node's rows, and names no workspace", async () => {
    const member = await listNotifications(sql, "alice", only(WS, ALICE));
    expect(member.map((n) => n.id)).toEqual(["in-ws"]);
    expect(await unreadNotificationCount(sql, "alice", only(WS, ALICE))).toBe(1);

    const admin = await listNotifications(sql, "alice", only(WS, ALICE), 20, true);
    expect(admin.map((n) => n.id).sort()).toEqual(["about-node", "in-ws"]);
    expect(admin.find((n) => n.id === "about-node")).toMatchObject({ workspace_id: null, workspace_name: null });
    expect(admin.find((n) => n.id === "in-ws")?.workspace_name).toBe("Acme");
    expect(await unreadNotificationCount(sql, "alice", only(WS, ALICE), true)).toBe(2);
  });

  it("reaches an administrator who belongs to no workspace at all", async () => {
    const rows = await listNotifications(sql, "alice", {}, 20, true);
    expect(rows.map((n) => n.id)).toEqual(["about-node"]);
    expect(await unreadNotificationCount(sql, "alice", {}, true)).toBe(1);
    expect(await markNotificationsRead(sql, "alice", [], undefined, undefined, true)).toBe(1);
    expect(await unreadNotificationCount(sql, "alice", {}, true)).toBe(0);
  });

  it("is marked read only by a caller who reads the node's rows, and never someone else's", async () => {
    expect(await markNotificationsRead(sql, "alice", [WS])).toBe(1);
    expect(await unreadNotificationCount(sql, "alice", only(WS, ALICE), true)).toBe(1);

    expect(await markNotificationsRead(sql, "alice", [WS], undefined, undefined, true)).toBe(1);
    expect(await unreadNotificationCount(sql, "alice", only(WS, ALICE), true)).toBe(0);
    expect(await unreadNotificationCount(sql, "bob", only(WS, BOB), true)).toBe(1);
  });

  it("is written once however often it is sent again", async () => {
    expect(await insertNotification(sql, row("about-node", { workspace_id: null }))).toBe(false);
    expect(await listNotifications(sql, "alice", {}, 20, true)).toHaveLength(1);
  });
});

describe.skipIf(!URL)("a notification is readable only while its resource is", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE notifications CASCADE`;
    await sql`TRUNCATE docs CASCADE`;
    await sql`TRUNCATE folders CASCADE`;
    await seedWorkspaces(sql);
  });

  it("a revoke empties the tray on the next read", async () => {
    await createDoc(sql, {
      workspaceId: WS,
      docId: "d1",
      owner: "user:alice",
      title: "Q3 Plan",
      aclPrincipals: ["user:alice", "user:bob"],
    });
    await insertNotification(
      sql,
      row("shared-with-bob", {
        recipient_alias: "bob",
        event_type: "DIRECT_DOC_PERMISSIONS",
        resource_id: "d1",
        resource_title: `alice shared "Q3 Plan" with you`,
      }),
    );

    expect((await listNotifications(sql, "bob", only(WS, BOB))).map((n) => n.id)).toEqual(["shared-with-bob"]);
    expect(await unreadNotificationCount(sql, "bob", only(WS, BOB))).toBe(1);

    await setDocAcl(sql, "d1", ["user:alice"], ["user:alice"], false, [], { p: [], w: [], c: [] });

    const stillStored = await sql<{ resource_title: string }[]>`
      SELECT resource_title FROM notifications WHERE id = 'shared-with-bob'`;
    expect(stillStored[0]!.resource_title).toBe(`alice shared "Q3 Plan" with you`);

    expect(await listNotifications(sql, "bob", only(WS, BOB))).toEqual([]);
    expect(await unreadNotificationCount(sql, "bob", only(WS, BOB))).toBe(0);
  });

  it("the unread count carries the same gate as the list", async () => {
    await createDoc(sql, {
      workspaceId: WS,
      docId: "d1",
      owner: "user:alice",
      title: "Q3 Plan",
      aclPrincipals: ["user:alice"],
    });
    await insertNotification(
      sql,
      row("unreadable", { recipient_alias: "bob", resource_id: "d1", resource_title: "Q3 Plan" }),
    );
    await insertNotification(sql, row("readable", { recipient_alias: "bob" }));

    expect((await listNotifications(sql, "bob", only(WS, BOB))).map((n) => n.id)).toEqual(["readable"]);
    expect(await unreadNotificationCount(sql, "bob", only(WS, BOB))).toBe(1);
  });

  it("gates a folder share on the folder's ACL", async () => {
    await createFolder(sql, {
      folderId: "f1",
      workspaceId: WS,
      owner: "user:alice",
      title: "Team",
      aclPrincipals: ["user:alice", "user:bob"],
    });
    await insertNotification(
      sql,
      row("folder-share", {
        recipient_alias: "bob",
        event_type: "DIRECT_DOC_PERMISSIONS",
        resource_id: "f1",
        resource_title: `alice shared "Team" with you`,
      }),
    );

    expect((await listNotifications(sql, "bob", only(WS, BOB))).map((n) => n.id)).toEqual(["folder-share"]);
    expect(await unreadNotificationCount(sql, "bob", only(WS, BOB))).toBe(1);

    await setFolderAcl(sql, "f1", ["user:alice"], ["user:alice"], false, { p: [], w: [], c: [] });

    expect(await listNotifications(sql, "bob", only(WS, BOB))).toEqual([]);
    expect(await unreadNotificationCount(sql, "bob", only(WS, BOB))).toBe(0);
  });

  it("keeps rows that name no resource, and drops rows whose resource is gone", async () => {
    await createDoc(sql, {
      workspaceId: WS,
      docId: "d1",
      owner: "user:alice",
      title: "Q3 Plan",
      aclPrincipals: ["user:alice"],
    });
    await insertNotification(sql, row("no-resource"));
    await insertNotification(sql, row("on-d1", { resource_id: "d1", resource_title: "Q3 Plan" }));

    expect((await listNotifications(sql, "alice", only(WS, ALICE))).map((n) => n.id).sort()).toEqual([
      "no-resource",
      "on-d1",
    ]);

    await deleteDoc(sql, "d1");

    expect((await listNotifications(sql, "alice", only(WS, ALICE))).map((n) => n.id)).toEqual(["no-resource"]);
    expect(await unreadNotificationCount(sql, "alice", only(WS, ALICE))).toBe(1);
  });

  it("principals are not a way around the recipient fence", async () => {
    await createDoc(sql, {
      workspaceId: WS,
      docId: "d1",
      owner: "user:alice",
      title: "Q3 Plan",
      aclPrincipals: ["user:alice", "user:bob"],
    });
    await insertNotification(sql, row("bobs", { recipient_alias: "bob", resource_id: "d1" }));

    expect(await listNotifications(sql, "alice", only(WS, ALICE))).toEqual([]);
    expect(await unreadNotificationCount(sql, "alice", only(WS, ALICE))).toBe(0);
    expect((await listNotifications(sql, "bob", only(WS, BOB))).map((n) => n.id)).toEqual(["bobs"]);
  });
});

describe.skipIf(!URL)("one tray across every workspace the caller belongs to", () => {
  let sql: Sql;

  /** A member of WS holding group:eng there, and a guest of OTHER_WS. */
  const ALICE_EVERYWHERE = {
    [WS]: ["user:alice", `org:${WS}`, "group:eng"],
    [OTHER_WS]: ["user:alice"],
  };

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE notifications CASCADE`;
    await sql`TRUNCATE docs CASCADE`;
    await sql`TRUNCATE folders CASCADE`;
    await sql`TRUNCATE groups CASCADE`;
    await sql`DELETE FROM workspace_members WHERE workspace_id IN (${WS}, ${OTHER_WS})`;
    await seedWorkspaces(sql);
  });

  it("lists rows from every workspace newest-first, each naming where it came from", async () => {
    await insertNotification(sql, row("here"));
    await insertNotification(sql, row("there", { workspace_id: OTHER_WS }));
    await sql`UPDATE notifications SET created_at = now() - interval '1 minute' WHERE id = 'here'`;

    const rows = await listNotifications(sql, "alice", ALICE_EVERYWHERE);
    expect(rows.map((n) => [n.id, n.workspace_id, n.workspace_name])).toEqual([
      ["there", OTHER_WS, "Side project"],
      ["here", WS, "Acme"],
    ]);
    expect(await unreadNotificationCount(sql, "alice", ALICE_EVERYWHERE)).toBe(2);
  });

  it("a workspace the caller has left contributes nothing", async () => {
    await insertNotification(sql, row("here"));
    await insertNotification(sql, row("left-behind", { workspace_id: OTHER_WS }));

    const reach = only(WS, ALICE_EVERYWHERE[WS]!);
    expect((await listNotifications(sql, "alice", reach)).map((n) => n.id)).toEqual(["here"]);
    expect(await unreadNotificationCount(sql, "alice", reach)).toBe(1);
    expect(await listNotifications(sql, "alice", {})).toEqual([]);
    expect(await unreadNotificationCount(sql, "alice", {})).toBe(0);
  });

  it("a group held in one workspace does not open a same-named grant in another", async () => {
    await createDoc(sql, {
      workspaceId: OTHER_WS,
      docId: "other-eng-doc",
      owner: "user:bob",
      title: "Their roadmap",
      aclPrincipals: ["user:bob", "group:eng"],
    });
    await insertNotification(
      sql,
      row("wrong-eng", { workspace_id: OTHER_WS, resource_id: "other-eng-doc", resource_title: "Their roadmap" }),
    );

    expect(await listNotifications(sql, "alice", ALICE_EVERYWHERE)).toEqual([]);
    expect(await unreadNotificationCount(sql, "alice", ALICE_EVERYWHERE)).toBe(0);
  });

  it("a row is gated in the resource's own workspace, not the one it is stamped with", async () => {
    await createDoc(sql, {
      workspaceId: OTHER_WS,
      docId: "other-eng-doc",
      owner: "user:bob",
      title: "Their roadmap",
      aclPrincipals: ["user:bob", "group:eng"],
    });
    await insertNotification(sql, row("mis-stamped", { resource_id: "other-eng-doc", resource_title: "Their roadmap" }));

    expect(await listNotifications(sql, "alice", ALICE_EVERYWHERE)).toEqual([]);
  });

  it("a direct grant in a guest workspace is readable", async () => {
    await createDoc(sql, {
      workspaceId: OTHER_WS,
      docId: "shared-with-guest",
      owner: "user:bob",
      title: "Brief",
      aclPrincipals: ["user:bob", "user:alice"],
    });
    await insertNotification(
      sql,
      row("guest-share", { workspace_id: OTHER_WS, resource_id: "shared-with-guest", resource_title: "Brief" }),
    );

    expect((await listNotifications(sql, "alice", ALICE_EVERYWHERE)).map((n) => n.id)).toEqual(["guest-share"]);
  });

  it("mark-all clears every workspace it is given and no other", async () => {
    await insertNotification(sql, row("here"));
    await insertNotification(sql, row("there", { workspace_id: OTHER_WS }));
    await insertNotification(sql, row("elsewhere", { workspace_id: "ws-not-mine" }));

    expect(await markNotificationsRead(sql, "alice", [WS, OTHER_WS])).toBe(2);
    const left = await sql<{ id: string }[]>`SELECT id FROM notifications WHERE read = FALSE`;
    expect(left.map((r) => r.id)).toEqual(["elsewhere"]);
    expect(await markNotificationsRead(sql, "alice", [])).toBe(0);
  });

  it("listMembershipGroups reports each membership with the groups held there", async () => {
    // A fresh alias: other suites leave memberships for "alice" behind.
    await addWorkspaceMember(sql, WS, "notif-carol", "member");
    await addWorkspaceMember(sql, OTHER_WS, "notif-carol", "guest");
    await upsertGroup(sql, "group:eng", ["user:notif-carol"], WS);
    await upsertGroup(sql, "group:eng", ["user:bob"], OTHER_WS);

    const got = await listMembershipGroups(sql, "notif-carol", "user:notif-carol");
    const byWs = Object.fromEntries(got.map((m) => [m.workspace_id, { role: m.role, groups: m.group_ids }]));
    expect(byWs).toEqual({
      [WS]: { role: "member", groups: ["group:eng"] },
      [OTHER_WS]: { role: "guest", groups: [] },
    });
  });
});
