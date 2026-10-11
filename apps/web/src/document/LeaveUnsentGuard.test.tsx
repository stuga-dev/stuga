// @vitest-environment jsdom
/** Asking before edits the node has not confirmed are left behind. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, useSyncExternalStore } from "react";
import type { Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { mountInto } from "../test/form-input";
import { forceReload } from "../sync/forced-reload";
import { LeaveUnsentGuard } from "./LeaveUnsentGuard";

/** Whether the page has unsent edits, settable from the test. */
const unsent = {
  value: true,
  listeners: new Set<() => void>(),
  set(next: boolean) {
    this.value = next;
    for (const l of this.listeners) l();
  },
};

function DocumentPage() {
  const value = useSyncExternalStore(
    (onChange) => {
      unsent.listeners.add(onChange);
      return () => unsent.listeners.delete(onChange);
    },
    () => unsent.value,
  );
  return <LeaveUnsentGuard unsent={value} />;
}

let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(async () => {
  unsent.value = true;
  ({ host, root } = mountInto());
  router = createMemoryRouter(
    [
      { path: "/doc/:id", element: <DocumentPage /> },
      { path: "/", element: <p>All documents</p> },
    ],
    { initialEntries: ["/doc/d1"] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
});

/** The dialog stays in the DOM while closed. */
const question = () =>
  [...document.querySelectorAll("dialog")].some((d) => d.open && d.textContent?.includes("Leave without your latest changes?"));
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);
const leave = () => act(async () => void router.navigate("/"));

describe("leaving for another page", () => {
  it("asks, and Stay keeps the page and its edits", async () => {
    await leave();
    expect(question()).toBe(true);
    expect(router.state.location.pathname).toBe("/doc/d1");

    await act(async () => button("Stay")!.click());
    expect(router.state.location.pathname).toBe("/doc/d1");
  });

  it("goes when the person chooses to leave anyway", async () => {
    await leave();
    await act(async () => button("Leave anyway")!.click());
    expect(router.state.location.pathname).toBe("/");
    expect(host.textContent).toContain("All documents");
  });

  it("goes on by itself once the edits arrive while it asks", async () => {
    await leave();
    expect(question()).toBe(true);
    await act(async () => unsent.set(false));
    expect(router.state.location.pathname).toBe("/");
  });

  it("does not ask when everything has reached the node", async () => {
    await act(async () => unsent.set(false));
    await leave();
    expect(question()).toBe(false);
    expect(router.state.location.pathname).toBe("/");
  });

  it("does not ask for a change of query on the same page, such as opening a comment", async () => {
    await act(async () => void router.navigate("/doc/d1?comment=3"));
    expect(question()).toBe(false);
    expect(router.state.location.search).toBe("?comment=3");
  });
});

describe("closing or reloading the tab", () => {
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("has the browser ask while edits are unsent, and only then", async () => {
    expect(unload()).toBe(true);
    await act(async () => unsent.set(false));
    expect(unload()).toBe(false);
  });

  // Last: the flag lasts as long as the page, which a forced reload ends.
  it("stands aside for a reload the node forced, whose edits cannot be kept", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    forceReload();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(unload()).toBe(false);
    vi.unstubAllGlobals();
  });
});
