// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const me = vi.hoisted(() => ({ models: vi.fn(), whoami: vi.fn(async () => ({ node_admin: true })) }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Me: me }));

const { ChatComposer } = await import("./ChatComposer");
const { invalidateModelOptions } = await import("../state/model-options");

let host: HTMLDivElement;
let root: Root;

function Where() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/doc/d1"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <ChatComposer value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} streaming={false} placeholder="Ask" canSend={false} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    ),
  );
  // The model list and the admin check each resolve on a later tick.
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const text = () => host.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

beforeEach(() => {
  invalidateModelOptions();
  me.models.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ChatComposer, for a node administrator", () => {
  it("is a prompt box while the node offers models", async () => {
    me.models.mockResolvedValue([{ id: "auto", name: "Auto", provider: "ollama" }]);
    await render();
    expect(host.querySelector("textarea")).toBeTruthy();
    expect(text()).not.toContain("AI is off");
  });

  it("is a prompt box when the list cannot be read, so the turn reports its own failure", async () => {
    me.models.mockRejectedValue(new Error("offline"));
    await render();
    expect(host.querySelector("textarea")).toBeTruthy();
  });

  it("says AI chat is off and leads to the AI settings when the node lists no models", async () => {
    me.models.mockResolvedValue([]);
    await render();
    expect(host.querySelector("textarea")).toBeNull();
    expect(text()).toContain("AI chat is off");
    expect(text()).not.toMatch(/node/i);
    await act(async () => button("AI settings")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe("/settings/node/ai");
  });
});
