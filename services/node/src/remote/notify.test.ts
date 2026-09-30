import { describe, expect, it } from "vitest";
import type { NodeRemoteAccessRow } from "@stuga/db";
import type { NotifyDeliverMessage } from "@stuga/protocol/internal/jobs";
import { bindingNotice, certNotices, movedNotice, notifyRemoteAccess, recoveredNotice, type RemoteNotice } from "./notify.js";

const HOST = "k7f3q2.mystuga.com";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-02T00:00:00Z");

function row(over: Partial<NodeRemoteAccessRow> = {}): NodeRemoteAccessRow {
  return {
    enabled: true,
    hostname: HOST,
    cert_serial: "87654321",
    cert_not_before: new Date(T0),
    cert_not_after: new Date(T0 + 90 * DAY),
    cert_failures: 0,
    binding_failing_since: null,
    last_error: null,
    ...over,
  } as NodeRemoteAccessRow;
}

const events = (notices: RemoteNotice[]) => notices.map((n) => `${n.event}:${n.key}`);

describe("the certificate warnings", () => {
  it("are none for a certificate with most of its life left, or none at all", () => {
    expect(certNotices(row(), T0 + 60 * DAY)).toEqual([]);
    expect(certNotices(row({ cert_serial: null, cert_failures: 5 }), T0)).toEqual([]);
  });

  it("say it expires soon under a tenth of its life, however long that life is", () => {
    const failed = row({ cert_failures: 1 });
    expect(events(certNotices(failed, T0 + 81 * DAY - 1))).toEqual([]);
    expect(events(certNotices(failed, T0 + 81 * DAY + 1))).toEqual(["REMOTE_CERT_EXPIRING:87654321"]);
    const shortLived = row({ cert_failures: 1, cert_not_after: new Date(T0 + 6 * DAY) });
    expect(events(certNotices(shortLived, T0 + 5 * DAY))).toEqual([]);
    expect(events(certNotices(shortLived, T0 + 5.5 * DAY))).toEqual(["REMOTE_CERT_EXPIRING:87654321"]);
  });

  it("say it runs short or has run out only once renewing it failed or can't be tried", () => {
    // Back from a long sleep, or turned on again: renewed before anyone hears of it.
    expect(certNotices(row(), T0 + 85 * DAY)).toEqual([]);
    expect(certNotices(row(), T0 + 91 * DAY)).toEqual([]);
    for (const code of ["denied", "retired", "upgrade_required", "binding_rejected"]) {
      expect(events(certNotices(row({ last_error: { code, message: "m", at: "" } }), T0 + 85 * DAY))).toEqual(["REMOTE_CERT_EXPIRING:87654321"]);
    }
    expect(certNotices(row({ last_error: { code: "dns_not_visible", message: "m", at: "" } }), T0 + 85 * DAY)).toEqual([]);
  });

  it("say it expired, and no longer that it expires soon", () => {
    const [notice, ...rest] = certNotices(row({ cert_failures: 1 }), T0 + 90 * DAY);
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ event: "REMOTE_CERT_EXPIRED", key: "87654321", title: "Remote access's certificate expired" });
    expect(notice!.body).toBe(`https://${HOST} can't be reached until there is a new one.`);
  });

  it("say renewing it fails after the third failure in a row, or at once when it waits for someone", () => {
    expect(certNotices(row({ cert_failures: 2 }), T0 + 61 * DAY)).toEqual([]);
    const failing = certNotices(row({ cert_failures: 3, last_error: { code: "acme_error", message: "The CA said no.", at: "" } }), T0 + 61 * DAY);
    expect(failing).toEqual([
      {
        event: "REMOTE_CERT_RENEWAL_FAILED",
        key: "87654321",
        title: "Remote access can't renew its certificate",
        body: `The certificate for https://${HOST} expires 2026-12-31 00:00 UTC. The CA said no.`,
      },
    ]);
    for (const code of ["acme_action_required", "issuance_budget"]) {
      expect(events(certNotices(row({ last_error: { code, message: "m", at: "" } }), T0 + 61 * DAY))).toEqual(["REMOTE_CERT_RENEWAL_FAILED:87654321"]);
    }
  });

  it("can be two at once", () => {
    expect(events(certNotices(row({ cert_failures: 7 }), T0 + 91 * DAY))).toEqual(["REMOTE_CERT_RENEWAL_FAILED:87654321", "REMOTE_CERT_EXPIRED:87654321"]);
  });

  it("end with one for the new certificate, keyed by the one warned about", () => {
    expect(recoveredNotice("87654321", HOST, new Date(T0 + 180 * DAY))).toEqual({
      event: "REMOTE_CERT_RECOVERED",
      key: "87654321",
      title: "Remote access has a new certificate",
      body: `The certificate for https://${HOST} is valid until 2027-03-31 00:00 UTC.`,
    });
  });
});

describe("the warning about the binding", () => {
  it("comes a day into the service's refusals, keyed by when they began", () => {
    const since = new Date(T0);
    expect(bindingNotice(row({ binding_failing_since: since }), T0 + DAY - 1)).toBeNull();
    expect(bindingNotice(row({ binding_failing_since: since }), T0 + DAY)).toMatchObject({
      event: "REMOTE_BINDING_REJECTED",
      key: "2026-10-02T00:00:00.000Z",
      title: "Remote access needs a restore code",
    });
  });

  it("comes at once for a key the node lost or can't read, keyed by when it found that", () => {
    const at = "2026-10-03T04:05:06.000Z";
    const lost = row({ last_error: { code: "binding_rejected", message: "This node's key for its remote address is missing. Enter a restore code to keep the address.", at } });
    expect(bindingNotice(lost, T0)).toMatchObject({ key: at, body: lost.last_error!.message });
    // The service's own, before a day of it: not yet.
    const refused = row({ binding_failing_since: new Date(T0), last_error: { code: "binding_rejected", message: "m", at, service_code: "unknown_key" } });
    expect(bindingNotice(refused, T0 + HOUR)).toBeNull();
    expect(bindingNotice(row(), T0)).toBeNull();
  });
});

describe("the notice of a move", () => {
  it("names the address that moved, keyed by when the node learned of it", () => {
    expect(movedNotice(HOST, "2026-10-03T04:05:06.000Z")).toEqual({
      event: "REMOTE_ADDRESS_MOVED",
      key: "2026-10-03T04:05:06.000Z",
      title: "Remote access moved to another computer",
      body: `https://${HOST} now reaches another computer. Remote access is off on this one.`,
    });
  });
});

describe("telling the administrators", () => {
  function setup(sink: "none" | "slack") {
    const rows: Array<{ id: string; event_type: string; recipient_alias: string; workspace_id: string | null; resource_url: string | null; resource_title: string | null }> = [];
    const deliveries: Array<NotifyDeliverMessage | null> = [];
    const db = {
      listNodeAdmins: async () => [{ alias: "liv" }, { alias: "sam" }],
      insertNotification: async (n: (typeof rows)[number], delivery: NotifyDeliverMessage | null) => {
        if (rows.some((r) => r.id === n.id)) return false;
        rows.push(n);
        deliveries.push(delivery);
        return true;
      },
    };
    const env = { sql: null as never, publicOrigin: "http://livs-air.local:8787", settings: { current: () => ({ notify: { sink } }) } } as never;
    return { rows, deliveries, send: (n: RemoteNotice) => notifyRemoteAccess(env, n, db as never) };
  }
  const notice: RemoteNotice = { event: "REMOTE_CERT_EXPIRED", key: "87654321", title: "t", body: "b" };

  it("writes one for each node administrator, about no workspace, linking to the remote access settings", async () => {
    const { rows, deliveries, send } = setup("slack");
    await send(notice);
    expect(rows).toMatchObject([
      { id: "REMOTE_CERT_EXPIRED:87654321:liv", event_type: "REMOTE_CERT_EXPIRED", recipient_alias: "liv", workspace_id: null, resource_title: "t" },
      { id: "REMOTE_CERT_EXPIRED:87654321:sam", recipient_alias: "sam" },
    ]);
    expect(rows[0]!.resource_url).toBe("http://livs-air.local:8787/settings/node/remote");
    expect(deliveries[0]).toEqual({ kind: "notify_deliver", recipient: "liv", title: "t", body: "b", url: "http://livs-air.local:8787/settings/node/remote" });
    await send(notice);
    expect(rows).toHaveLength(2);
  });

  it("sends nothing through a sink the node has none of", async () => {
    const { deliveries, send } = setup("none");
    await send(notice);
    expect(deliveries).toEqual([null, null]);
  });
});
