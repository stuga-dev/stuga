// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mountInto } from "../test/form-input";
import { LIVE_REFRESH_IDLE_MS, LIVE_REFRESH_MS, useLiveRefresh } from "./use-live-refresh";

const onRefresh = vi.fn();
let visibility: DocumentVisibilityState = "visible";

function Probe() {
  useLiveRefresh(onRefresh);
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  onRefresh.mockReset();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const { root } = mountInto();
  await act(async () => root.render(<Probe />));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLiveRefresh", () => {
  it("re-reads on an interval while the tab is visible and nobody is working in it", () => {
    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("waits for a pause in typing or clicking", () => {
    vi.advanceTimersByTime(LIVE_REFRESH_MS - 1000);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    vi.advanceTimersByTime(1000);
    expect(onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(LIVE_REFRESH_IDLE_MS).toBeLessThan(LIVE_REFRESH_MS);
  });

  it("skips a hidden tab, and re-reads at once when it comes back", () => {
    visibility = "hidden";
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 3);
    expect(onRefresh).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the window regains focus, once for a focus and a visibility change together", () => {
    window.dispatchEvent(new FocusEvent("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
