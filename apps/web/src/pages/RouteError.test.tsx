// @vitest-environment jsdom
/** A page that fails to render shows the app's own error page, with a way back. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { mountInto } from "../test/form-input";
import { RouteError } from "./RouteError";

function Broken(): never {
  throw new Error("render failed");
}

afterEach(() => vi.restoreAllMocks());

describe("RouteError", () => {
  it("says what happened in plain words and goes back to the documents", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, root } = mountInto();
    const router = createMemoryRouter(
      [
        { path: "/doc/:id", element: <Broken />, errorElement: <RouteError /> },
        { path: "/", element: <p>All documents here</p> },
      ],
      { initialEntries: ["/doc/d1"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));

    expect(host.textContent).toContain("Something went wrong");
    expect(host.textContent).toContain("This page stopped working. Reload it to carry on.");
    expect(host.textContent).not.toContain("Unexpected Application Error");
    const back = [...host.querySelectorAll("button")].find((b) => b.textContent === "All documents")!;
    await act(async () => back.click());
    expect(router.state.location.pathname).toBe("/");
    expect(host.textContent).toContain("All documents here");
  });
});
