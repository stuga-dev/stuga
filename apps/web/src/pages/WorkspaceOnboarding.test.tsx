// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveWorkspace } from "../lib/session/workspace-pointer";
import { chooseRadio, pickFile } from "../test/form-input";

const services = vi.hoisted(() => ({
  create: vi.fn(),
  createFromSample: vi.fn(),
  importArchive: vi.fn(),
  samples: vi.fn(),
  samplesAgain: vi.fn(),
  list: vi.fn(),
  whoami: vi.fn(),
  ai: vi.fn(),
}));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Workspaces: {
    create: services.create,
    createFromSample: services.createFromSample,
    importArchive: services.importArchive,
    samples: services.samples,
    samplesAgain: services.samplesAgain,
    cachedSamples: () => undefined,
    list: services.list,
  },
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

const PRIVACY_LAWS = { id: "privacy-laws", title: "Privacy laws", description: "Six laws in their own languages.", name: "Privacy laws (sample)", langs: ["en", "zh"] };

const { IMPORT_CHECK_MS, IMPORT_GIVE_UP_MS, WorkspaceOnboarding } = await import("./WorkspaceOnboarding");

let host: HTMLDivElement;
let root: Root;
/** Each element brought into view; jsdom has no scrollIntoView. */
let scrolled: Element[];

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
          <Route path="/doc/:docId" element={<Destination />} />
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
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  services.create.mockReset().mockResolvedValue({ workspace_id: "w_1" });
  services.importArchive.mockReset().mockResolvedValue({ workspace_id: "w_2", start_doc_id: "d_start" });
  services.createFromSample.mockReset().mockResolvedValue({ workspace_id: "w_3", start_doc_id: "d_laws" });
  services.samples.mockReset().mockResolvedValue({ samples: [PRIVACY_LAWS] });
  services.samplesAgain.mockReset().mockResolvedValue({ samples: [PRIVACY_LAWS] });
  services.list.mockReset().mockResolvedValue({ workspaces: [], active: null });
  services.whoami.mockReset().mockResolvedValue({ node_admin: false });
  services.ai.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
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
  it("creates a workspace from a file, under the name its archive carries, and opens the document it starts with", async () => {
    await render();
    await chooseRadio(host, "From a file");
    expect(button("Create workspace")?.disabled).toBe(true);
    const file = new File(["PK"], "Team handbook.stuga.zip", { type: "application/zip" });
    await pickFile(host, file);
    expect(host.querySelector("input")!.placeholder).toBe("The archive’s name");
    await click("Create workspace");

    expect(services.importArchive).toHaveBeenCalledWith(file, "", "workspace_edit");
    expect(services.create).not.toHaveBeenCalled();
    expect(getActiveWorkspace()).toBe("w_2");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/doc/d_start");
  });

  it("opens an imported workspace's start document after an administrator's AI step", async () => {
    services.whoami.mockResolvedValue({ node_admin: true });
    services.ai.mockResolvedValue(NOTHING_SET_UP);
    await render();
    await chooseRadio(host, "From a file");
    await pickFile(host, new File(["PK"], "Handbook.zip", { type: "application/zip" }));
    await click("Create workspace");
    expect(host.textContent).toContain("Your workspace is ready");
    await click("Start using Stuga");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/doc/d_start");
  });

  it("creates a workspace from a sample, named after it, and opens its start document after an administrator's AI step", async () => {
    services.whoami.mockResolvedValue({ node_admin: true });
    services.ai.mockResolvedValue(NOTHING_SET_UP);
    await render();
    expect(host.textContent).toContain("Six laws in their own languages.");
    await chooseRadio(host, "Privacy laws");
    expect(host.querySelector("input")!.value).toBe("Privacy laws (sample)");
    await click("Create workspace");

    expect(services.createFromSample).toHaveBeenCalledWith("privacy-laws", "Privacy laws (sample)", "workspace_edit");
    expect(services.create).not.toHaveBeenCalled();
    expect(getActiveWorkspace()).toBe("w_3");
    await click("Start using Stuga");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/doc/d_laws");
  });

  it("says samples need an internet connection when the node has none to offer, and offers them once the browser is back online", async () => {
    services.samples.mockResolvedValue({ samples: [], unavailable: true });
    await render();
    expect(host.textContent).toContain("Samples need an internet connection.");
    expect(host.textContent).not.toContain("Privacy laws");
    await act(async () => void window.dispatchEvent(new Event("online")));
    expect(host.textContent).not.toContain("Samples need an internet connection.");
    expect(host.textContent).toContain("Privacy laws");
  });

  it("says why an archive could not be imported and stays on the page", async () => {
    services.importArchive.mockRejectedValue(new Error("cannot import this archive: stuga.json: is missing"));
    await render();
    await chooseRadio(host, "From a file");
    await pickFile(host, new File(["PK"], "Handbook.zip", { type: "application/zip" }));
    await click("Create workspace");
    expect(host.textContent).toContain("cannot import this archive: stuga.json: is missing");
    // The page may be scrolled down to the file; the error heads it.
    expect(scrolled.filter((el) => el.textContent?.includes("Workspace creation failed"))).toHaveLength(1);
    expect(host.querySelector('[data-testid="destination"]')).toBeNull();
    expect(button("Create workspace")?.disabled).toBe(false);
  });

  it("opens the workspace an import it stopped waiting for makes, once the node lists it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    services.importArchive.mockRejectedValue(Object.assign(new Error("try again"), { status: 504 }));
    await render();
    await chooseRadio(host, "From a file");
    await pickFile(host, new File(["PK"], "Handbook.zip", { type: "application/zip" }));
    await click("Create workspace");
    expect(host.textContent).toContain("The import may still finish");
    expect(host.textContent).toContain("This page opens the workspace when it does.");
    expect(host.textContent).not.toContain("Workspace creation failed");

    // At the top of a long form: brought into view, as an error would be.
    expect(scrolled.filter((el) => el.textContent?.includes("The import may still finish"))).toHaveLength(1);

    await act(async () => vi.advanceTimersByTime(IMPORT_CHECK_MS));
    expect(services.list).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="destination"]')).toBeNull();

    // Nothing asks for a second meanwhile, which the node would refuse, or copy once the first is done.
    expect(button("Create workspace")?.disabled).toBe(true);
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(services.importArchive).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("The import may still finish");

    services.list.mockResolvedValue({ workspaces: [{ workspace_id: "w_9", name: "Handbook", role: "owner" }], active: "w_9" });
    await act(async () => vi.advanceTimersByTime(IMPORT_CHECK_MS));
    expect(getActiveWorkspace()).toBe("w_9");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/");
    await act(async () => vi.advanceTimersByTime(IMPORT_CHECK_MS * 3));
    expect(services.list).toHaveBeenCalledTimes(2);
  });

  it("stops looking, and says the import did not finish, once the node would have stopped it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    services.importArchive.mockRejectedValue(Object.assign(new Error("try again"), { status: 504 }));
    await render();
    await chooseRadio(host, "From a file");
    await pickFile(host, new File(["PK"], "Handbook.zip", { type: "application/zip" }));
    await click("Create workspace");
    expect(host.textContent).toContain("The import may still finish");

    await act(async () => vi.advanceTimersByTimeAsync(IMPORT_GIVE_UP_MS - IMPORT_CHECK_MS));
    expect(host.textContent).toContain("The import may still finish");
    expect(host.textContent).not.toContain("Workspace creation failed");
    await act(async () => vi.advanceTimersByTimeAsync(IMPORT_CHECK_MS));
    expect(host.textContent).not.toContain("The import may still finish");
    expect(host.textContent).toContain("The import didn’t finish. Try again.");
    const looked = services.list.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(IMPORT_CHECK_MS * 3));
    expect(services.list).toHaveBeenCalledTimes(looked);

    // A try after it starts over: the old failure does not stay up.
    expect(button("Create workspace")?.disabled).toBe(false);
    await click("Create workspace");
    expect(services.importArchive).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("The import didn’t finish");
    expect(host.textContent).toContain("The import may still finish");
  });
});
