// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveWorkspace } from "../lib/session/workspace-pointer";

const services = vi.hoisted(() => ({
  create: vi.fn(),
  whoami: vi.fn(),
  ai: vi.fn(),
}));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Workspaces: { create: services.create },
  Me: { whoami: services.whoami },
  NodeSettings: { ai: services.ai },
}));
vi.mock("../agents/ConnectAgent", () => ({ AgentClients: () => <p>Agent setup</p> }));
/** Stands in for the real form: one click connects its half the way a save would answer. */
vi.mock("./settings/node/ConnectForm", () => ({
  ConnectForm: ({ half, onConnected }: { half: "chat" | "search"; onConnected: (r: { settings: unknown }) => void }) => (
    <button onClick={() => onConnected({ settings: half === "chat" ? CHAT_SET_UP : SEARCH_SET_UP })}>Connect {half}</button>
  ),
}));

const NOTHING_SET_UP = {
  provider_base_urls: { openai: "https://api.openai.com/v1" },
  chat: { endpoints: [] },
  embed: { model: null, provider: "", base_url: "" },
};
const CHAT_SET_UP = {
  ...NOTHING_SET_UP,
  chat: { endpoints: [{ id: "openai", provider: "openai", base_url: "https://api.openai.com/v1", models: [{ id: "gpt-5", name: "GPT-5" }] }] },
};
const SEARCH_SET_UP = { ...CHAT_SET_UP, embed: { model: "text-embedding-3-small", provider: "openai", base_url: "https://api.openai.com/v1" } };

const { WorkspaceOnboarding } = await import("./WorkspaceOnboarding");

let host: HTMLDivElement;
let root: Root;

function Destination() {
  return <p data-testid="destination">{useLocation().pathname}</p>;
}

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding" element={<WorkspaceOnboarding />} />
          <Route path="/" element={<Destination />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

function button(label: string) {
  return [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
}

function buttons(label: string) {
  return [...host.querySelectorAll("button")].filter((b) => b.textContent === label);
}

async function press(target: HTMLButtonElement | undefined) {
  expect(target).toBeDefined();
  await act(async () => target!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function click(label: string) {
  const target = button(label);
  expect(target, `no button ${label}`).toBeDefined();
  await act(async () => target!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function name(value: string) {
  const input = host.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  services.create.mockReset().mockResolvedValue({ workspace_id: "w_1" });
  services.whoami.mockReset().mockResolvedValue({ node_admin: false });
  services.ai.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("WorkspaceOnboarding", () => {
  it("creates a workspace with the chosen default and enters it for a regular member", async () => {
    await render();
    expect(host.textContent).toContain("Start on your own and invite others when you’re ready.");
    expect(button("Create workspace")?.disabled).toBe(true);
    await name("  My projects  ");
    await click("Create workspace");

    expect(services.create).toHaveBeenCalledWith("My projects", "workspace_edit");
    expect(getActiveWorkspace()).toBe("w_1");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/");
  });

  it("offers an administrator their own agent, built-in AI and search by meaning, none required", async () => {
    services.whoami.mockResolvedValue({ node_admin: true });
    services.ai.mockResolvedValue(NOTHING_SET_UP);
    await render();
    await name("Team notes");
    await click("Create workspace");

    expect(host.textContent).toContain("Your workspace is ready");
    for (const row of ["Your own AI", "Built-in AI", "Search by meaning"]) expect(host.textContent).toContain(row);
    expect(host.textContent).toContain("Just for you: each member connects their own.");
    expect(host.textContent).toContain("for every member, on your API key");
    expect(buttons("Set up")).toHaveLength(3);
    await click("Start using Stuga");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/");
  });

  it("opens an outside agent's setup in place and folds it away with Done", async () => {
    services.whoami.mockResolvedValue({ node_admin: true });
    services.ai.mockResolvedValue(NOTHING_SET_UP);
    await render();
    await name("Team notes");
    await click("Create workspace");

    await press(buttons("Set up")[0]);
    expect(host.textContent).toContain("Agent setup");
    expect(buttons("Set up")).toHaveLength(2);
    await click("Done");
    expect(host.textContent).not.toContain("Agent setup");
    expect(buttons("Set up")).toHaveLength(3);
  });

  it("shows what was connected in each AI row once it is set up", async () => {
    services.whoami.mockResolvedValue({ node_admin: true });
    services.ai.mockResolvedValue(NOTHING_SET_UP);
    await render();
    await name("Team notes");
    await click("Create workspace");

    await press(buttons("Set up")[1]);
    await click("Connect chat");
    expect(host.textContent).toContain("OpenAI · GPT-5");
    expect(buttons("Set up")).toHaveLength(2);

    await press(buttons("Set up")[1]);
    await click("Connect search");
    expect(host.textContent).toContain("OpenAI · text-embedding-3-small");
    expect(buttons("Set up")).toHaveLength(1);
    expect(host.querySelectorAll(".astryx-status-dot")).toHaveLength(2);
  });
});
