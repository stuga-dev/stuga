// @vitest-environment jsdom
// The notifications store is a module-level cache; each test resets it rather
// than re-importing, which would give the component a second React.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/session/workspace-pointer";
import type { Notification } from "../api";
import {
  refreshNotifications,
  refreshNotificationRows,
  resetNotificationsForTest,
} from "../state/notifications";
import { NotificationsBell, deliveryLine } from "./NotificationsBell";
import { mountInto } from "../test/form-input";
import { loadUiLanguage } from "../i18n/i18n";

const T0 = "2026-08-19T10:00:00.000Z";

function notif(id: string, over: Partial<Notification> = {}): Notification {
  return {
    id,
    workspace_id: "ws1",
    workspace_name: "Acme",
    event_type: "DIRECT_DOC_PERMISSIONS",
    resource_id: "d1",
    resource_title: "Plan",
    resource_url: null,
    actor_alias: "alice",
    payload: { actor: "alice", doc: "Plan" },
    read: false,
    created_at: T0,
    ...over,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

let calls: FetchCall[];
let responder: (url: string, method: string) => unknown;
/** Hold the rows fetch or the count poll in flight until releaseGets(). */
let gateGets: boolean;
let gateUnread: boolean;
let pendingGets: Array<() => void>;
let root: Root;

/** The router's current path. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

async function mount({ withRows = true }: { withRows?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <LayerProvider>
          <NotificationsBell />
          <LocationProbe />
        </LayerProvider>
      </MemoryRouter>,
    );
  });
  // The poll refreshes only the count; `withRows: false` leaves the rows unloaded.
  await act(async () => {
    refreshNotifications();
    if (withRows) refreshNotificationRows();
  });
}

/** Answers the count poll and the rows fetch from one fixture. */
function serve(rows: Notification[], postUpdated = 1) {
  return (url: string, method: string) => {
    if (method === "POST") return { ok: true, updated: postUpdated };
    if (url.includes("/unread")) return { unread: rows.filter((n) => !n.read).length };
    return { notifications: rows };
  };
}

/** Let every parked GET respond with what `responder` says now. */
async function releaseGets(): Promise<void> {
  await act(async () => {
    for (const release of pendingGets.splice(0)) release();
  });
}

/** A button anywhere on the page by its text. */
function button(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === label);
}

function bell(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".notif-trigger button");
  if (!el) throw new Error("no bell rendered");
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  calls = [];
  gateGets = false;
  gateUnread = false;
  pendingGets = [];
  resetNotificationsForTest();
  setActiveWorkspace("ws1");
  responder = () => ({ notifications: [] });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET" && (url.includes("/unread") ? gateUnread : gateGets)) {
      await new Promise<void>((resolve) => pendingGets.push(resolve));
    }
    return new Response(JSON.stringify(responder(url, method)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  ({ root } = mountInto());
});

describe("NotificationsBell", () => {
  it("claims nothing while the first load is in flight, then shows the rows unread", async () => {
    gateGets = true;
    responder = serve([notif("n1"), notif("n2")], 2);
    await mount({ withRows: false });
    await click(bell());

    expect(document.body.textContent).not.toContain("You’re all caught up.");
    await releaseGets();

    expect(document.body.textContent).toContain('alice shared “Plan” with you');
    expect(document.querySelectorAll(".notif-unread-mark--on")).toHaveLength(2);
    // Opening reads; it marks nothing.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(document.querySelector(".notif-dot")).not.toBeNull();
  });

  it("shows the dot and counts unread in the accessible name", async () => {
    responder = serve([notif("n1"), notif("n2"), notif("n3", { read: true })]);
    await mount();
    expect(document.querySelector(".notif-dot")).not.toBeNull();
    expect(bell().getAttribute("aria-label")).toBe("Notifications (2 unread)");
  });

  it("reads the count again when it opens, so a new mention shows at once", async () => {
    responder = serve([]);
    await mount();
    responder = serve([notif("n1")]);
    calls.length = 0;
    await click(bell());
    expect(calls.some((c) => c.url.includes("/unread"))).toBe(true);
    expect(document.querySelector(".notif-dot")).not.toBeNull();
  });

  it("Mark all as read marks up to the newest row shown and puts the dot out at once", async () => {
    responder = serve([notif("n1"), notif("n2")], 2);
    await mount();
    await click(bell());
    await click(button("Mark all as read")!);

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/notifications/read");
    // Bounded by the newest row shown, so a row that arrived since keeps its unread state.
    expect(post?.body).toEqual({ before: T0 });
    expect(document.querySelector(".notif-dot")).toBeNull();
    expect(document.querySelectorAll(".notif-unread-mark--on")).toHaveLength(0);
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
    expect(button("Mark all as read")).toBeUndefined();
  });

  it("a count poll from before the mark cannot relight the dot", async () => {
    responder = serve([notif("n1")]);
    await mount();
    await click(bell());

    gateUnread = true;
    await act(async () => {
      refreshNotifications();
    });
    await click(button("Mark all as read")!);
    expect(document.querySelector(".notif-dot")).toBeNull();

    await releaseGets();
    expect(document.querySelector(".notif-dot")).toBeNull();
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
  });

  it("a rows response from before the mark does not un-read the tray", async () => {
    responder = serve([notif("n1")]);
    await mount();
    await click(bell());
    await click(button("Mark all as read")!);

    // The same rows again, still unread server-side.
    await act(async () => {
      refreshNotificationRows();
    });
    expect(document.querySelector(".notif-dot")).toBeNull();
    expect(document.querySelectorAll(".notif-unread-mark--on")).toHaveLength(0);
  });

  it("fetches the rows once per open, and marks nothing", async () => {
    // Uncached rows, as on a session's first open, where a second fetch would not coalesce.
    responder = serve([notif("n1"), notif("n2")], 2);
    await mount({ withRows: false });
    calls.length = 0;
    await click(bell());

    expect(calls.filter((c) => c.method === "GET" && !c.url.includes("/unread"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("still pulls rows that arrive while the tray is open", async () => {
    responder = serve([notif("n1")]);
    await mount();
    await click(bell());
    calls.length = 0;

    responder = serve([notif("n2", { created_at: "2026-08-19T11:00:00.000Z" }), notif("n1")]);
    await act(async () => {
      refreshNotifications();
    });
    expect(calls.some((c) => c.method === "GET" && !c.url.includes("/unread"))).toBe(true);
  });

  it("never claims “all caught up” when the dot says otherwise", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: null });
      if (method === "GET" && url.includes("/unread")) {
        return new Response(JSON.stringify({ unread: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("list is down", { status: 500 });
    }) as typeof fetch;

    await mount();
    await click(bell());
    expect(document.querySelector(".notif-dot")).not.toBeNull();
    expect(document.body.textContent).not.toContain("You’re all caught up.");
    expect(document.body.textContent).toContain("Couldn’t load notifications.");
  });

  it("offers nothing to mark when nothing is unread", async () => {
    responder = serve([notif("n1", { read: true })]);
    await mount();
    await click(bell());
    expect(button("Mark all as read")).toBeUndefined();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("navigates document rows to the document, marking that row read", async () => {
    responder = serve([notif("n1")]);
    await mount();
    await click(bell());

    const row = [...document.querySelectorAll<HTMLElement>("li, [role='listitem']")].find((el) =>
      el.textContent?.includes('alice shared “Plan” with you'),
    );
    expect(row).toBeTruthy();
    const target = row!.querySelector<HTMLElement>("button, [role='button'], a") ?? row!;
    await click(target);
    expect(document.querySelector("[data-testid='loc']")?.textContent).toBe("/doc/d1");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ ids: ["n1"] });
    expect(document.querySelector(".notif-dot")).toBeNull();
  });

  it("opens a comment's notification at that comment", async () => {
    responder = serve([
      notif("n1", {
        event_type: "MENTIONED_IN_COMMENT",
        payload: { actor: "alice", doc: "Plan", excerpt: "see this" },
        resource_url: "https://node.example/doc/d1?comment=7",
      }),
    ]);
    await mount();
    await click(bell());
    const row = [...document.querySelectorAll<HTMLElement>("li")].find((el) => el.textContent?.includes("Plan"));
    await click(row!.querySelector<HTMLElement>("button, [role='button'], a") ?? row!);
    expect(document.querySelector("[data-testid='loc']")?.textContent).toBe("/doc/d1?comment=7");
  });

  it("names the workspace only on rows from another one", async () => {
    responder = serve([
      notif("here", { payload: { actor: "alice", doc: "Here row" } }),
      notif("there", { payload: { actor: "alice", doc: "There row" }, workspace_id: "ws2", workspace_name: "Side project" }),
    ]);
    await mount();
    await click(bell());

    const rowText = (title: string) =>
      [...document.querySelectorAll<HTMLElement>("li")].find((el) => el.textContent?.includes(title))?.textContent;
    expect(rowText("There row")).toContain("Side project");
    expect(rowText("Here row")).not.toContain("Acme");
  });

  it("opens a row about the node where it points, staying in this workspace and naming none", async () => {
    responder = serve([
      notif("sec", {
        workspace_id: null,
        workspace_name: null,
        event_type: "SECURITY_UPDATE_AVAILABLE",
        resource_id: null,
        resource_title: null,
        payload: { running: "1.9.0", latest: "1.10.0", securityVersion: "1.9.1" },
        resource_url: "https://node.example/settings/node/about",
        delivery_channel: "none",
      }),
    ]);
    await mount();
    const before = getActiveWorkspace();
    await click(bell());

    const row = [...document.querySelectorAll<HTMLElement>("li, [role='listitem']")].find((el) =>
      el.textContent?.includes("Security update available: Stuga 1.10.0"),
    );
    expect(row).toBeTruthy();
    expect(row!.textContent).not.toContain("null");
    // With no channel on the node, the bell is the only place it went, which needs no saying.
    expect(row!.textContent).not.toContain("Stuga only");
    const target = row!.querySelector<HTMLElement>("button, [role='button'], a") ?? row!;
    await click(target);
    expect(getActiveWorkspace()).toBe(before);
    expect(document.querySelector("[data-testid='loc']")?.textContent).toBe("/settings/node/about");
  });

  it("opening a row from another workspace switches to it instead of routing in this one", async () => {
    responder = serve([notif("there", { resource_id: "d9", workspace_id: "ws2", workspace_name: "Side project" })]);
    await mount();
    await click(bell());

    const row = [...document.querySelectorAll<HTMLElement>("li, [role='listitem']")].find((el) =>
      el.textContent?.includes("Side project"),
    );
    const target = row!.querySelector<HTMLElement>("button, [role='button'], a") ?? row!;
    await click(target);
    expect(getActiveWorkspace()).toBe("ws2");
    // A switch reloads through window.location, which jsdom ignores.
    expect(document.querySelector("[data-testid='loc']")?.textContent).toBe("/");
  });
});

describe("whether an alert also went out", () => {
  it("says so in each of its states, the channel by name", () => {
    expect(deliveryLine({ delivery_channel: "none" })).toBeUndefined();
    // A row from before this was kept says nothing, rather than claim it was never sent.
    expect(deliveryLine({ delivery_channel: null })).toBeUndefined();
    expect(deliveryLine({})).toBeUndefined();
    expect(deliveryLine({ delivery_channel: "email", delivered_at: null, delivery_error: null })).toBe("Sending by email…");
    expect(deliveryLine({ delivery_channel: "slack", delivered_at: "2026-09-30T10:00:00Z", delivery_error: null })).toBe("Also sent by Slack.");
    expect(deliveryLine({ delivery_channel: "email", delivered_at: null, delivery_error: "no_email_address" })).toBe(
      "Not sent by email: you have no email address in Stuga.",
    );
    expect(deliveryLine({ delivery_channel: "webhook", delivered_at: null, delivery_error: "sink_answered:500" })).toBe(
      "Not sent by webhook: it answered 500.",
    );
    expect(deliveryLine({ delivery_channel: "teams", delivered_at: null, delivery_error: "failed:connect ECONNREFUSED." })).toBe(
      "Not sent by Teams: connect ECONNREFUSED.",
    );
    expect(deliveryLine({ delivery_channel: "slack", delivered_at: null, delivery_error: "channel_changed" })).toBe(
      "Not sent by Slack: the notification channel changed before it was sent.",
    );
  });
});

describe("in the reader’s language", () => {
  afterEach(async () => {
    await loadUiLanguage("en");
  });

  it("writes each row from its event and params, and says how it went out", async () => {
    await loadUiLanguage("de");
    responder = serve([notif("n1")]);
    await mount();
    await click(bell());
    expect(document.body.textContent).toContain("alice hat „Plan“ mit dir geteilt");
    expect(bell().getAttribute("aria-label")).toBe("Benachrichtigungen (1 ungelesen)");
    expect(deliveryLine({ delivery_channel: "email", delivered_at: null, delivery_error: "email_not_set_up" })).toBe(
      "Nicht per E-Mail gesendet: E-Mail ist nicht eingerichtet.",
    );
    await loadUiLanguage("ja");
    expect(deliveryLine({ delivery_channel: "slack", delivered_at: "2026-09-30T10:00:00Z", delivery_error: null })).toBe("Slackでも送信しました。");
  });
});
