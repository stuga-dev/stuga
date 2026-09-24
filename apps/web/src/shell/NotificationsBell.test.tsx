// @vitest-environment jsdom
// The notifications store is a module-level cache; each test resets it rather
// than re-importing, which would give the component a second React.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/session/workspace-pointer";
import type { Notification } from "../api";
import {
  refreshNotifications,
  refreshNotificationRows,
  resetNotificationsForTest,
} from "../state/notifications";
import { NotificationsBell } from "./NotificationsBell";

const T0 = "2026-08-19T10:00:00.000Z";

function notif(id: string, over: Partial<Notification> = {}): Notification {
  return {
    id,
    workspace_id: "ws1",
    workspace_name: "Acme",
    event_type: "DIRECT_DOC_PERMISSIONS",
    resource_id: "d1",
    resource_title: `alice shared "Plan" with you`,
    resource_url: null,
    actor_alias: "alice",
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
let container: HTMLDivElement;
let root: Root;

/** The router's current path. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
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

function bell(): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>("button")].find((b) =>
    b.getAttribute("aria-label")?.startsWith("Notifications"),
  );
  if (!el) throw new Error("no bell rendered");
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("NotificationsBell", () => {
  it("claims nothing while the first load is in flight, and marks the rows once they land", async () => {
    gateGets = true;
    responder = serve([notif("n1"), notif("n2")], 2);
    await mount({ withRows: false });
    await click(bell());

    expect(document.body.textContent).not.toContain("You’re all caught up.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await releaseGets();

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/notifications/read");
    expect(post?.body).toEqual({ before: T0 });
    expect(document.body.textContent).toContain('alice shared "Plan" with you');
    expect(document.querySelector(".notif-dot")).toBeNull();
  });

  it("shows the dot and counts unread in the accessible name", async () => {
    responder = serve([notif("n1"), notif("n2"), notif("n3", { read: true })]);
    await mount();
    expect(document.querySelector(".notif-dot")).not.toBeNull();
    expect(bell().getAttribute("aria-label")).toBe("Notifications (2 unread)");
  });

  it("opening the tray marks the seen backlog read and puts the dot out immediately", async () => {
    responder = serve([notif("n1"), notif("n2")], 2);
    await mount();
    await click(bell());

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/notifications/read");
    // Bounded by the newest row shown, so a row that arrived since keeps its unread state.
    expect(post?.body).toEqual({ before: T0 });
    expect(document.querySelector(".notif-dot")).toBeNull();
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
  });

  it("a count poll from before the mark cannot relight the dot", async () => {
    responder = serve([notif("n1")]);
    await mount();

    gateUnread = true;
    await act(async () => {
      refreshNotifications();
    });
    await click(bell());
    expect(document.querySelector(".notif-dot")).toBeNull();

    await releaseGets();
    expect(document.querySelector(".notif-dot")).toBeNull();
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
  });

  it("a rows response from before the mark does not un-read the tray", async () => {
    responder = serve([notif("n1")]);
    await mount({ withRows: false });
    gateGets = true;
    await click(bell());
    gateGets = false;
    await releaseGets();

    expect(document.querySelector(".notif-dot")).toBeNull();
    expect(document.body.textContent).toContain('alice shared "Plan" with you');
    // The same rows again, still unread server-side.
    await act(async () => {
      refreshNotificationRows();
    });
    expect(document.querySelector(".notif-dot")).toBeNull();
  });

  it("fetches the rows once per open, and marks once", async () => {
    // Uncached rows, as on a session's first open, where a second fetch would not coalesce.
    responder = serve([notif("n1"), notif("n2")], 2);
    await mount({ withRows: false });
    calls.length = 0;
    await click(bell());

    expect(calls.filter((c) => c.method === "GET" && !c.url.includes("/unread"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
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

  it("does not POST at all when nothing is unread", async () => {
    responder = serve([notif("n1", { read: true })]);
    await mount();
    await click(bell());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("navigates document rows to the document", async () => {
    responder = serve([notif("n1")]);
    await mount();
    await click(bell());

    const row = [...document.querySelectorAll<HTMLElement>("li, [role='listitem']")].find((el) =>
      el.textContent?.includes('alice shared "Plan" with you'),
    );
    expect(row).toBeTruthy();
    const target = row!.querySelector<HTMLElement>("button, [role='button'], a") ?? row!;
    await click(target);
    expect(document.querySelector("[data-testid='loc']")?.textContent).toBe("/doc/d1");
  });

  it("names the workspace only on rows from another one", async () => {
    responder = serve([
      notif("here", { resource_title: "Here row" }),
      notif("there", { resource_title: "There row", workspace_id: "ws2", workspace_name: "Side project" }),
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
        resource_title: "Security update available: Stuga 1.10.0",
        resource_url: "https://node.example/settings/node/about",
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
