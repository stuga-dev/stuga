// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { NodeHealthBanner } = await import("./NodeHealthBanner");
const { HEALTHY_POLL_MS, TROUBLED_POLL_MS } = await import("../state/node-health");

let root: Root;
const fetchMock = vi.fn();
const text = () => document.body.textContent ?? "";

/** A response with the shape the probe reads: status plus the node's JSON body. */
const reply = (status: number, body: unknown = { ok: status === 200 }) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

/** What a reverse proxy's SPA fallback answers: 200, and not JSON at all. */
const spaFallback = () =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token <")) });

/** Let the pending probe resolve, then run `ms` of timers. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

beforeEach(async () => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setOnline(true);
  document.body.innerHTML = "";
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(): Promise<void> {
  await act(async () => root.render(<NodeHealthBanner />));
  await settle();
}

describe("the node health banner", () => {
  it("shows nothing at all while the node is healthy", async () => {
    fetchMock.mockImplementation(() => reply(200));
    await mount();
    await settle(HEALTHY_POLL_MS * 3);
    expect(text()).toBe("");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("probes /ready, the endpoint that runs a query, on mount", async () => {
    fetchMock.mockImplementation(() => reply(200));
    await mount();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/ready");
  });

  it("stays quiet through a single 503", async () => {
    fetchMock.mockImplementationOnce(() => reply(503)).mockImplementation(() => reply(200));
    await mount();
    expect(text()).toBe("");
  });

  it("names the database once a second 503 confirms it", async () => {
    fetchMock.mockImplementation(() => reply(503));
    await mount();
    await settle(TROUBLED_POLL_MS);
    expect(text()).toMatch(/can’t reach its database/i);
  });

  it("blames the connection, not the database, when nothing answers", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("network down")));
    await mount();
    await settle(TROUBLED_POLL_MS);
    expect(text()).toMatch(/Can’t reach the server/i);
    expect(text()).not.toMatch(/database/i);
  });

  it("reads a proxy's 502 as an unreachable server, not as the node's own verdict", async () => {
    fetchMock.mockImplementation(() => reply(502));
    await mount();
    await settle(TROUBLED_POLL_MS);
    expect(text()).toMatch(/Can’t reach the server/i);
  });

  it("takes the banner away as soon as the node recovers", async () => {
    fetchMock.mockImplementation(() => reply(503));
    await mount();
    await settle(TROUBLED_POLL_MS);
    expect(text()).not.toBe("");

    fetchMock.mockImplementation(() => reply(200));
    await settle(TROUBLED_POLL_MS);
    expect(text()).toBe("");
  });

  it("refuses to read a proxy's index.html fallback as health", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(spaFallback);
    await mount();
    await settle(TROUBLED_POLL_MS * 3);
    expect(text()).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/\/ready/);
    warn.mockRestore();
  });

  it("does not accuse the server while this browser is offline", async () => {
    setOnline(false);
    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    await mount();
    await settle(TROUBLED_POLL_MS * 4);
    expect(text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
