// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const me = vi.hoisted(() => ({ whoami: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Me: me }));

const { AiSetupNotice } = await import("./AiSetupNotice");

let host: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AiSetupNotice />
      </MemoryRouter>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

// One file per answer: the admin check is cached for the page load.
describe("AiSetupNotice, for someone who is not a node administrator", () => {
  it("offers their own AI rather than the settings when the check fails", async () => {
    me.whoami.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(host.textContent).toContain("Ask your administrator to turn it on, or use your own AI.");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Connect your own AI"]);
  });

  it("names who can turn AI on, and offers their own AI instead of a page that would refuse them", async () => {
    me.whoami.mockResolvedValue({ node_admin: false });
    await render();
    expect(host.textContent).toContain("AI chat is off");
    expect(host.textContent).toContain("Ask your administrator to turn it on, or use your own AI.");
    // Outside Settings and the switcher the UI never says "node".
    expect(host.textContent).not.toMatch(/node/i);
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Connect your own AI"]);
  });
});
