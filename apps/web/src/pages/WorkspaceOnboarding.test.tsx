// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveWorkspace } from "../lib/session/workspace-pointer";
import { chooseRadio, chooseSegment, mountInto, pickFile, typeInto } from "../test/form-input";

const services = vi.hoisted(() => ({
  create: vi.fn(),
  createFromSample: vi.fn(),
  checkImport: vi.fn(),
  importHeld: vi.fn(),
  discardImport: vi.fn(),
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
    checkImport: services.checkImport,
    importHeld: services.importHeld,
    discardImport: services.discardImport,
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

/** The name field, below the start's own inputs. */
const nameInput = () => host.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
const name = (value: string) => typeInto(nameInput(), value);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  services.create.mockReset().mockResolvedValue({ workspace_id: "w_1" });
  services.checkImport.mockReset().mockResolvedValue({ import_id: "wsi_1", name: "Team handbook", expires_at: "2026-09-28T01:00:00Z" });
  services.importHeld.mockReset().mockResolvedValue({ workspace_id: "w_2", start_doc_id: "d_start" });
  services.discardImport.mockReset().mockResolvedValue(undefined);
  services.createFromSample.mockReset().mockResolvedValue({ workspace_id: "w_3", start_doc_id: "d_laws" });
  services.samples.mockReset().mockResolvedValue({ samples: [PRIVACY_LAWS] });
  services.samplesAgain.mockReset().mockResolvedValue({ samples: [PRIVACY_LAWS] });
  services.list.mockReset().mockResolvedValue({ workspaces: [], active: null });
  services.whoami.mockReset().mockResolvedValue({ node_admin: false });
  services.ai.mockReset();
  ({ host, root } = mountInto());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceOnboarding", () => {
  it("goes into a workspace the account is a member of after all, as after being added back", async () => {
    sessionStorage.setItem("stuga_membership_ended", "Bakery");
    services.list.mockResolvedValue({ workspaces: [{ workspace_id: "w_5", name: "Bakery", role: "member" }], active: "w_5" });
    await render();
    expect(getActiveWorkspace()).toBe("w_5");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/");
    expect(sessionStorage.getItem("stuga_membership_ended")).toBeNull();
  });

  it("names the workspace the person is no longer a member of", async () => {
    sessionStorage.setItem("stuga_membership_ended", "Bakery");
    await render();
    expect(host.textContent).toContain("You are no longer a member of Bakery");
    expect(host.textContent).toContain("Create your workspace");
  });

  it("says nothing of a membership to a new account", async () => {
    await render();
    expect(host.textContent).not.toContain("no longer a member");
  });

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

  it("offers an administrator their own agent, built-in AI and semantic search, none required", async () => {
    services.whoami.mockResolvedValue({ node_admin: true });
    services.ai.mockResolvedValue(NOTHING_SET_UP);
    await render();
    await name("Team notes");
    await click("Create workspace");

    expect(host.textContent).toContain("Your workspace is ready");
    for (const row of ["Your AI agents", "Built-in AI", "Semantic search"]) expect(host.textContent).toContain(row);
    expect(host.textContent).toContain("Each member connects their own.");
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
    await chooseSegment(host, "Import");
    expect(button("Create workspace")?.disabled).toBe(true);
    const file = new File(["PK"], "Team handbook.stuga.zip", { type: "application/zip" });
    await pickFile(host, file);
    expect(nameInput().placeholder).toBe("Taken from the file");
    await click("Create workspace");

    expect(services.checkImport).toHaveBeenCalledWith(file);
    expect(services.importHeld).toHaveBeenCalledWith("wsi_1", "", "workspace_edit");
    expect(services.create).not.toHaveBeenCalled();
    // An import ends with its summary; the workspace opens from there.
    expect(host.textContent).toContain("Imported “");
    await click("Open workspace");
    expect(getActiveWorkspace()).toBe("w_2");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/doc/d_start");
  });

  it("lists what a file would leave out and imports it only on Import", async () => {
    services.checkImport.mockResolvedValue({
      import_id: "wsi_2",
      name: "Notion",
      expires_at: "2026-09-28T01:00:00Z",
      left_out: { count: 1, files: [{ path: "Home/Brief.pdf", reason: "not_linked" }] },
    });
    await render();
    await chooseSegment(host, "Import");
    await pickFile(host, new File(["PK"], "Export.zip", { type: "application/zip" }));
    await click("Create workspace");

    expect(host.querySelector('.astryx-banner[data-status="warning"]')?.textContent).toContain("1 file won’t be imported");
    expect(host.textContent).toContain("Home/Brief.pdf");
    expect(host.textContent).toContain("Not a page, and no page links to it");
    expect(host.textContent).toContain("Import a workspace");
    expect(services.importHeld).not.toHaveBeenCalled();
    expect(button("Create workspace")).toBeUndefined();
    await click("Back");
    expect(services.discardImport).toHaveBeenCalledWith("wsi_2");
    await click("Create workspace");
    await click("Import");
    expect(services.importHeld).toHaveBeenCalledWith("wsi_2", "", "workspace_edit");
    await click("Open workspace");
    expect(getActiveWorkspace()).toBe("w_2");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/doc/d_start");
  });

  it("opens an imported workspace's start document after an administrator's AI step", async () => {
    services.whoami.mockResolvedValue({ node_admin: true });
    services.ai.mockResolvedValue(NOTHING_SET_UP);
    await render();
    await chooseSegment(host, "Import");
    await pickFile(host, new File(["PK"], "Handbook.zip", { type: "application/zip" }));
    await click("Create workspace");
    await click("Open workspace");
    expect(host.textContent).toContain("Your workspace is ready");
    await click("Start using Stuga");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/doc/d_start");
  });

  it("creates a workspace from a sample, named after it, and opens its start document after an administrator's AI step", async () => {
    services.whoami.mockResolvedValue({ node_admin: true });
    services.ai.mockResolvedValue(NOTHING_SET_UP);
    await render();
    await chooseSegment(host, "Sample");
    expect(host.textContent).toContain("Six laws in their own languages.");
    await chooseRadio(host, "Privacy laws");
    expect(nameInput().value).toBe("Privacy laws (sample)");
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
    await chooseSegment(host, "Sample");
    expect(host.textContent).toContain("Samples need an internet connection.");
    expect(host.textContent).not.toContain("Privacy laws");
    await act(async () => void window.dispatchEvent(new Event("online")));
    expect(host.textContent).not.toContain("Samples need an internet connection.");
    expect(host.textContent).toContain("Privacy laws");
  });

  it("says why an archive could not be imported and stays on the page", async () => {
    services.checkImport.mockRejectedValue(new Error("cannot import this archive: stuga.json: is missing"));
    await render();
    await chooseSegment(host, "Import");
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
    services.importHeld.mockRejectedValue(Object.assign(new Error("try again"), { status: 504 }));
    await render();
    await chooseSegment(host, "Import");
    await pickFile(host, new File(["PK"], "Handbook.zip", { type: "application/zip" }));
    await click("Create workspace");
    expect(host.textContent).toContain("The import may still finish");
    expect(host.textContent).toContain("This page opens the workspace when it does.");
    expect(host.textContent).not.toContain("Workspace creation failed");

    // At the top of a long form: brought into view, as an error would be.
    expect(scrolled.filter((el) => el.textContent?.includes("The import may still finish"))).toHaveLength(1);

    await act(async () => vi.advanceTimersByTime(IMPORT_CHECK_MS));
    // Once on arrival, once by the import's check.
    expect(services.list).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="destination"]')).toBeNull();

    // Nothing asks for a second meanwhile, which the node would refuse, or copy once the first is done.
    expect(button("Create workspace")?.disabled).toBe(true);
    await act(async () => nameInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(services.importHeld).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("The import may still finish");

    services.list.mockResolvedValue({ workspaces: [{ workspace_id: "w_9", name: "Handbook", role: "owner" }], active: "w_9" });
    await act(async () => vi.advanceTimersByTime(IMPORT_CHECK_MS));
    expect(getActiveWorkspace()).toBe("w_9");
    expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/");
    await act(async () => vi.advanceTimersByTime(IMPORT_CHECK_MS * 3));
    expect(services.list).toHaveBeenCalledTimes(3);
  });

  it("stops looking, and says the import did not finish, once the node would have stopped it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    services.importHeld.mockRejectedValue(Object.assign(new Error("try again"), { status: 504 }));
    await render();
    await chooseSegment(host, "Import");
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
    expect(services.importHeld).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("The import didn’t finish");
    expect(host.textContent).toContain("The import may still finish");
  });
});
