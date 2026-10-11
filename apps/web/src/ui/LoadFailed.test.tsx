// @vitest-environment jsdom
/** A failed load says when the browser is offline, and tries again once it is back. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { mountInto } from "../test/form-input";
import { LoadFailed } from "./LoadFailed";

let host: HTMLDivElement;
let root: Root;

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

beforeEach(() => {
  ({ host, root } = mountInto());
});

afterEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

describe("a failed load", () => {
  it("names what failed while the network is up", async () => {
    await act(async () => root.render(<LoadFailed title="Couldn’t open this item" onRetry={() => {}} />));
    expect(host.textContent).toContain("Couldn’t open this item");
  });

  it("says the person is offline instead, and loads again when they are back", async () => {
    const retry = vi.fn();
    await act(async () => setOnline(false));
    await act(async () => root.render(<LoadFailed title="Couldn’t open this item" onRetry={retry} />));
    expect(host.textContent).toContain("You’re offline");
    expect(host.textContent).not.toContain("Couldn’t open this item");
    expect(retry).not.toHaveBeenCalled();

    await act(async () => setOnline(true));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Couldn’t open this item");
  });

  it("does not retry by itself for a failure that had nothing to do with the network", async () => {
    const retry = vi.fn();
    await act(async () => root.render(<LoadFailed onRetry={retry} />));
    await act(async () => setOnline(true));
    expect(retry).not.toHaveBeenCalled();
  });
});
