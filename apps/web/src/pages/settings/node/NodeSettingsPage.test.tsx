// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router-dom";
import type { NodeAiSettings, NodeBackups, NodeOperationalSettings, NodeVersion } from "../../../api";
import { brandingConfig, setAuthConfigForTest } from "../../../lib/session/auth-config";
import { nodeLabel, nodeName } from "../../../shell/Brand";

const me = vi.hoisted(() => ({ whoami: vi.fn() }));
const nodeApi = vi.hoisted(() => ({
  ai: vi.fn(),
  saveAi: vi.fn(),
  testAi: vi.fn(),
  discoverModels: vi.fn(),
  settings: vi.fn(),
  saveSettings: vi.fn(),
  admins: vi.fn(),
  version: vi.fn(),
  checkVersion: vi.fn(),
  backups: vi.fn(),
  backUpNow: vi.fn(),
  installVersion: vi.fn(),
}));

vi.mock("../../../api", async (orig) => ({
  ...(await orig<typeof import("../../../api")>()),
  Me: me,
  NodeSettings: nodeApi,
}));
vi.mock("./NodeAudit", () => ({ NodeAudit: () => null }));

const { NodeSettingsPage } = await import("./index");

// jsdom's <dialog> has no showModal/close, which Astryx Dialog calls.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

const AI: NodeAiSettings = {
  chat: {
    enabled: true,
    running: true,
    default_model: "gpt-4.1",
    endpoints: [
      {
        id: "openai-1",
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        models: [{ id: "gpt-4.1", name: "gpt-4.1" }],
        api_key_set: true,
        api_key_fingerprint: "abcd1234",
        api_key_stale: false,
      },
    ],
  },
  embed: {
    enabled: true,
    running: false,
    provider: "ollama",
    base_url: "http://127.0.0.1:11434",
    model: "",
    api_key_set: false,
    api_key_fingerprint: null,
    api_key_stale: false,
    search_max_distance: null,
    retrieval_max_distance: null,
  },
  embedding_column_dims: 1024,
  max_distance_defaults: { search: 0.6, retrieval: 0.9 },
  provider_base_urls: { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com", ollama: "http://127.0.0.1:11434" },
  updated_by: null,
  updated_at: null,
};

const BACKUPS: NodeBackups = {
  auto: true,
  hour: 3,
  time_zone: "UTC",
  next_at: "2026-09-24T03:00:00Z",
  running: false,
  waiting: null,
  attempted_at: "2026-09-23T03:00:00Z",
  error: null,
  dir: "/backups",
  keep: 7,
  backups: [
    { name: "2026-09-23T030001Z", created_at: "2026-09-23T03:00:01Z", bytes: 12 * 1024 * 1024, stuga_version: "1.9.0", before_upgrade: false },
    { name: "2026-09-22T101500Z", created_at: "2026-09-22T10:15:00Z", bytes: 11 * 1024 * 1024, stuga_version: "1.8.0", before_upgrade: true },
  ],
};

/** A node nobody has set AI up on. */
const FRESH: NodeAiSettings = { ...AI, chat: { enabled: true, running: false, default_model: "", endpoints: [] } };

/** Semantic search on a local Ollama beside the OpenAI chat provider. */
const WITH_SEARCH: NodeAiSettings = { ...AI, embed: { ...AI.embed, model: "bge-m3", running: true } };

const OPS: NodeOperationalSettings = {
  node_name: null,
  node_label: "localhost",
  limits: { max_upload_mb: 25, ceiling_mb: 100 },
  maintenance: { audit_retention_days: 365, database_ops_keep: 1000, ai_usage_retention_days: 0, ask_thread_retention_days: 0 },
  notify: {
    sink: "slack",
    email_from: null,
    webhook_set: false,
    webhook_label: null,
    webhook_stale: false,
    smtp_set: false,
    smtp_label: null,
    smtp_stale: false,
  },
  branding: { accent_color: null },
  updates: { check: true },
  backups: { auto: true, hour: 3 },
  time_zone: "UTC",
  search: { languages: [], choices: ["ko", "ar"], rebuilding: false, error: null },
  identity_provider: {
    issuer: null,
    client_id: null,
    label: null,
    default_label: null,
    scopes: null,
    default_scopes: "openid profile email",
    client_secret_set: false,
    client_secret_label: null,
    client_secret_stale: false,
    callback_urls: ["http://localhost:8787/auth/oidc/callback", "http://mac.local:8787/auth/oidc/callback"],
    accounts_without_password: 0,
  },
  restart_hint: "",
  node: {
    node_id: "k3q7m2x9vbn4ha5z",
    public_origin: "http://localhost:8787",
    extra_origins: [],
    bind: "127.0.0.1",
    port: 8787,
    data_dir: "/data",
    database: "stuga",
    embedding_dims: 1024,
  },
  updated_by: null,
  updated_at: null,
};

const NO_UPDATE = {
  comparable: true,
  checked_at: null,
  error: null,
  available: null,
  releases_url: "https://github.com/stuga-dev/stuga/releases",
  upgrade_hint: "Run ./stuga upgrade.",
  install: { available: false, status: null },
};

/** A build from source, as a development node reports itself. */
const SOURCE: NodeVersion = {
  version: "0.0.0-dev",
  build: "source",
  released_at: null,
  source_url: "https://github.com/stuga-dev/stuga",
  previous_version: null,
  first_boot_at: null,
  last_boot_at: null,
  update: { ...NO_UPDATE, comparable: false },
};

/** A released build that has looked and found nothing newer. */
const RELEASE: NodeVersion = {
  ...SOURCE,
  version: "1.9.0",
  build: "release",
  released_at: "2026-11-03",
  source_url: "https://github.com/stuga-dev/stuga/tree/v1.9.0",
  update: { ...NO_UPDATE, checked_at: new Date().toISOString() },
};

const NEWER = { version: "1.10.0", released_at: "2026-12-01", security: false, notes_url: "https://github.com/stuga-dev/stuga/releases/tag/v1.10.0" };

let host: HTMLDivElement;
let root: Root;
let navigate!: NavigateFunction;

function CaptureNavigate() {
  navigate = useNavigate();
  return null;
}

async function go(category: string) {
  await act(async () => {
    await navigate(`/settings/node/${category}`);
  });
}

function isShown(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if ((cur as HTMLElement).style?.display === "none") return false;
  }
  return true;
}

/** Inputs by label, on the visible section only. */
function inputs(labelText: string): HTMLInputElement[] {
  return [...host.querySelectorAll("input")].filter(
    (i) => isShown(i) && (host.querySelector(`label[for="${i.id}"]`)?.textContent ?? "").includes(labelText),
  );
}

async function typeInto(input: HTMLInputElement | undefined, value: string) {
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Type and blur, which is when a NumberInput commits. */
async function commitNumber(input: HTMLInputElement | undefined, value: string) {
  await act(async () => input!.focus());
  await typeInto(input, value);
  await act(async () => input!.blur());
}

async function click(label: string) {
  const el = [...host.querySelectorAll("button")].find((b) => isShown(b) && b.textContent === label);
  expect(el, `no visible button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** The nth visible button with this label: the chat half's comes before semantic search's. */
async function clickNth(label: string, n: number) {
  const el = [...host.querySelectorAll("button")].filter((b) => isShown(b) && b.textContent === label)[n];
  expect(el, `no visible button ${label} #${n}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** Flip the switch labelled so. */
async function flip(label: string) {
  const el = [...host.querySelectorAll('input[role="switch"]')].find(
    (i) => isShown(i) && (host.querySelector(`label[for="${i.id}"]`)?.textContent ?? i.getAttribute("aria-label")) === label,
  ) as HTMLInputElement | undefined;
  expect(el, `no switch ${label}`).toBeTruthy();
  await act(async () => el!.click());
}

/** Enter in a field, which lists a service's models. */
async function pressEnter(input: HTMLInputElement | undefined) {
  expect(input).toBeTruthy();
  await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

/** Pick an option of the visible selector labelled so. */
async function choose(labelText: string, optionText: string) {
  const label = [...host.querySelectorAll("label")].find((l) => isShown(l) && l.textContent === labelText);
  expect(label, `no selector ${labelText}`).toBeTruthy();
  const trigger = document.getElementById(label!.getAttribute("for")!)!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const option = [...listbox.querySelectorAll('[role="option"]')].find((o) => o.textContent === optionText);
  expect(option, `no option ${optionText}`).toBeTruthy();
  await act(async () => option!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const isDisabled = (b: HTMLButtonElement | undefined) => !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");

const visibleButtons = (label: string) => [...host.querySelectorAll("button")].filter((b) => isShown(b) && b.textContent === label);

/** Semantic search's editor, with its match cutoffs showing. */
async function openSearchEditor() {
  await clickNth("Edit", 1);
  await click("Match cutoffs");
}

/** A button in the open dialog, which shares its label with the one that opened it. */
async function confirmIn(label: string) {
  const el = [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === label);
  expect(el, `no ${label} in an open dialog`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** The next save answers with these settings, as the node would after writing them. */
const savedAs = (settings: NodeAiSettings) =>
  nodeApi.saveAi.mockResolvedValue({ settings, probe: { ok: true, chat: [], embed: { ok: true, skipped: true } }, reembed: null });

/** Let the section's requests and their re-renders finish. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Render the AI section afresh over other settings. */
async function renderWith(ai: NodeAiSettings) {
  nodeApi.ai.mockResolvedValue(ai);
  await remount();
}

/** Render the page afresh, over whatever the node now answers. */
async function remount() {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/settings/node/ai"]}>
        <CaptureNavigate />
        <Routes>
          <Route path="/settings/node/:category" element={<NodeSettingsPage />} />
          <Route path="/settings/agents" element={<p>Your own AI page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  me.whoami.mockResolvedValue({ node_admin: true });
  nodeApi.ai.mockResolvedValue(AI);
  nodeApi.settings.mockResolvedValue(OPS);
  nodeApi.admins.mockResolvedValue({ admins: [] });
  nodeApi.version.mockResolvedValue(SOURCE);
  nodeApi.backups.mockResolvedValue(BACKUPS);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/settings/node/ai"]}>
        <CaptureNavigate />
        <Routes>
          <Route path="/settings/node/:category" element={<NodeSettingsPage />} />
          <Route path="/settings/agents" element={<p>Your own AI page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  setAuthConfigForTest(null);
});

describe("NodeSettingsPage", () => {
  it("keeps an unsaved AI provider draft across a switch to another section and back", async () => {
    // Set-up services are summary rows, so nothing asks for a key yet.
    expect(inputs("API key")).toHaveLength(0);
    await click("Connect another provider");
    expect(inputs("API key")).toHaveLength(1);
    await typeInto(inputs("API key")[0], "sk-draft");

    await go("notifications");
    expect(inputs("API key")).toHaveLength(0);
    await go("ai");

    expect(inputs("API key")).toHaveLength(1);
    expect(inputs("API key")[0]!.value).toBe("sk-draft");
  });

  it("connects a first provider on the model the administrator picks, with no switch to turn on", async () => {
    await renderWith(FRESH);
    await clickNth("Set up", 0);
    nodeApi.discoverModels.mockResolvedValue({ models: ["gpt-5.2", "gpt-5.1", "gpt-4.1"] });
    savedAs(AI);

    await typeInto(inputs("API key")[0], "sk-new");
    await pressEnter(inputs("API key")[0]);
    await settle();
    expect(nodeApi.discoverModels).toHaveBeenCalledWith("chat", "openai", "https://api.openai.com/v1", "sk-new");
    // Nothing is picked for the administrator, so Connect waits for a model.
    expect(isDisabled(visibleButtons("Connect")[0])).toBe(true);

    await choose("Model", "gpt-5.2");
    await click("Connect");
    await settle();

    expect(nodeApi.saveAi).toHaveBeenCalledTimes(1);
    const sent = nodeApi.saveAi.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("embed");
    expect(sent.chat).toEqual({
      enabled: true,
      default_model: "gpt-5.2",
      endpoints: [{ id: expect.stringMatching(/^openai-/), provider: "openai", base_url: "https://api.openai.com/v1", models: [{ id: "gpt-5.2", name: "gpt-5.2" }], api_key: "sk-new" }],
    });
  });

  it("names a model that cannot chat when the save's probe refuses it", async () => {
    await renderWith(FRESH);
    await clickNth("Set up", 0);
    nodeApi.discoverModels.mockResolvedValue({ models: ["gpt-new-voice", "gpt-5.2"] });
    nodeApi.saveAi.mockRejectedValue(new Error('chat completions 404: {"error":{"message":"This is not a chat model and thus not supported in the v1/chat/completions endpoint."}}'));

    await typeInto(inputs("API key")[0], "sk-new");
    await pressEnter(inputs("API key")[0]);
    await settle();
    await choose("Model", "gpt-new-voice");
    await click("Connect");
    await settle();

    expect(host.textContent).toContain("gpt-new-voice doesn’t take chat requests. Choose another model.");
  });

  it("says the key was refused, and saves nothing", async () => {
    await renderWith(FRESH);
    await clickNth("Set up", 0);
    nodeApi.discoverModels.mockResolvedValue({ models: [], message: 'models 401: {"error":"invalid x-api-key"}' });

    await typeInto(inputs("API key")[0], "sk-wrong");
    await pressEnter(inputs("API key")[0]);
    await settle();

    expect(host.textContent).toContain("OpenAI didn’t accept that key.");
    expect(nodeApi.saveAi).not.toHaveBeenCalled();
  });

  it("asks for a model id when the service lists none, then connects on it", async () => {
    await renderWith(FRESH);
    await clickNth("Set up", 0);
    nodeApi.discoverModels.mockResolvedValue({ models: [] });
    savedAs(AI);

    await typeInto(inputs("API key")[0], "sk-new");
    await pressEnter(inputs("API key")[0]);
    await settle();

    await typeInto(inputs("Model")[0], "house-model");
    await click("Connect");
    await settle();
    const sent = nodeApi.saveAi.mock.calls[0]![0] as { chat: { default_model: string; endpoints: Array<{ models: unknown }> } };
    expect(sent.chat.default_model).toBe("house-model");
    expect(sent.chat.endpoints[0]!.models).toEqual([{ id: "house-model", name: "house-model" }]);
  });

  it("switches chat off with its providers kept, and leaves semantic search alone", async () => {
    savedAs({ ...AI, chat: { ...AI.chat, enabled: false, running: false } });
    await flip("Built-in AI");
    await settle();

    const sent = nodeApi.saveAi.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("embed");
    expect(sent.chat).toEqual({
      enabled: false,
      default_model: "gpt-4.1",
      endpoints: [{ id: "openai-1", provider: "openai", base_url: "https://api.openai.com/v1", models: [{ id: "gpt-4.1", name: "gpt-4.1" }] }],
    });
  });

  it("sends someone with their own subscription to Your own AI, where their agent connects", async () => {
    await settle();
    const link = [...host.querySelectorAll("a, button")].find((e) => e.textContent === "Your own AI");
    expect(link, "no Your own AI link").toBeDefined();
    await act(async () => link!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.textContent).toContain("Your own AI page");
  });

  it("sets semantic search up on its own, as for an agent that brings its own chat", async () => {
    await renderWith(FRESH);
    nodeApi.discoverModels.mockResolvedValue({ models: ["text-embedding-3-large", "text-embedding-3-small"] });
    savedAs({ ...FRESH, embed: { ...FRESH.embed, provider: "openai", model: "text-embedding-3-small", running: true } });

    // Semantic search's Set up is the second; chat's form stays closed.
    await clickNth("Set up", 1);
    expect(inputs("API key")).toHaveLength(1);
    await typeInto(inputs("API key")[0], "sk-embed");
    await pressEnter(inputs("API key")[0]);
    await settle();
    expect(nodeApi.discoverModels).toHaveBeenCalledWith("embed", "openai", "https://api.openai.com/v1", "sk-embed");

    // Nothing is picked for the administrator here either.
    expect(isDisabled(visibleButtons("Connect")[0])).toBe(true);
    await choose("Model", "text-embedding-3-small");
    await click("Connect");
    await settle();
    expect(nodeApi.saveAi).toHaveBeenCalledWith({
      embed: { provider: "openai", base_url: "https://api.openai.com/v1", model: "text-embedding-3-small", api_key: "sk-embed" },
    });
    expect(host.textContent).toContain("Search by meaning is on with text-embedding-3-small.");
  });

  it("removes semantic search only after asking, forgetting its model and key", async () => {
    await renderWith(WITH_SEARCH);
    savedAs(AI);
    await clickNth("Remove", 1);
    expect(nodeApi.saveAi).not.toHaveBeenCalled();

    await confirmIn("Remove");
    await settle();
    expect(nodeApi.saveAi).toHaveBeenCalledWith({ embed: { provider: "", base_url: "", model: "", api_key: "" } });
  });

  it("leaves unset cutoffs empty under their defaults, and an untouched save keeps them unset", async () => {
    await renderWith(WITH_SEARCH);
    await openSearchEditor();
    expect(inputs("Search cutoff")[0]!.value).toBe("");
    expect(inputs("Search cutoff")[0]!.placeholder).toBe("Default 0.6");
    expect(inputs("Retrieval cutoff")[0]!.value).toBe("");
    expect(inputs("Retrieval cutoff")[0]!.placeholder).toBe("Default 0.9");
    savedAs(WITH_SEARCH);

    await click("Save");

    const sent = nodeApi.saveAi.mock.calls[0]![0] as { embed: Record<string, unknown> };
    expect(sent.embed).toMatchObject({ enabled: true, model: "bge-m3", search_max_distance: null, retrieval_max_distance: null });
  });

  it("saves the match cutoffs with semantic search, a cleared one as the default", async () => {
    await renderWith(WITH_SEARCH);
    await openSearchEditor();
    await commitNumber(inputs("Search cutoff")[0], "1.1");
    await commitNumber(inputs("Retrieval cutoff")[0], "1.4");
    savedAs({ ...WITH_SEARCH, embed: { ...WITH_SEARCH.embed, search_max_distance: 1.1, retrieval_max_distance: 1.4 } });
    await click("Save");
    await settle();

    await openSearchEditor();
    expect(inputs("Search cutoff")[0]!.value).toBe("1.1");
    await commitNumber(inputs("Retrieval cutoff")[0], "");
    savedAs({ ...WITH_SEARCH, embed: { ...WITH_SEARCH.embed, search_max_distance: 1.1 } });
    await click("Save");

    expect(nodeApi.saveAi).toHaveBeenCalledTimes(2);
    const [first, second] = nodeApi.saveAi.mock.calls.map((c) => c[0] as { chat?: unknown; embed: Record<string, unknown> });
    expect(first!.chat).toBeUndefined();
    expect(first!.embed).toMatchObject({ search_max_distance: 1.1, retrieval_max_distance: 1.4 });
    expect(second!.embed).toMatchObject({ search_max_distance: 1.1, retrieval_max_distance: null });
  });

  it("saves one provider without touching semantic search, and keeps its unsaved cutoff draft", async () => {
    await renderWith(WITH_SEARCH);
    await openSearchEditor();
    await commitNumber(inputs("Search cutoff")[0], "1.1");
    nodeApi.discoverModels.mockResolvedValue({ models: ["gpt-4.1", "gpt-4o"] });
    savedAs(WITH_SEARCH);

    await clickNth("Edit", 0);
    await settle();
    // The saved key is used to list the models: nothing was typed.
    expect(nodeApi.discoverModels).toHaveBeenCalledWith("chat", "openai", "https://api.openai.com/v1", undefined);
    await clickNth("Save", 0);

    const sent = nodeApi.saveAi.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("embed");
    expect(sent.chat).toMatchObject({ enabled: true, default_model: "gpt-4.1", endpoints: [{ id: "openai-1" }] });
    expect(inputs("Search cutoff")[0]!.value).toBe("1.1");
  });

  it("steps a cutoff by 0.05 from its value", async () => {
    await renderWith(WITH_SEARCH);
    await openSearchEditor();
    const input = inputs("Search cutoff")[0]!;
    await commitNumber(input, "0.6");
    const press = (key: string) => act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    await press("ArrowUp");
    expect(input.value).toBe("0.65");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(input.value).toBe("0.55");
  });

  it("keeps each settings section's own draft while another section is open", async () => {
    await go("notifications");
    await typeInto(inputs("Webhook URL")[0], "https://hooks.slack.com/services/T/B/X");
    await go("branding");
    await typeInto(inputs("Name")[0], "Acme");
    await go("access");
    await typeInto(inputs("Add an administrator")[0], "sam");

    await go("notifications");
    expect(inputs("Webhook URL")[0]!.value).toBe("https://hooks.slack.com/services/T/B/X");
    await go("branding");
    expect(inputs("Name")[0]!.value).toBe("Acme");
    await go("access");
    expect(inputs("Add an administrator")[0]!.value).toBe("sam");
  });

  it("saves a new identity provider as typed, with its secret and default label and scopes", async () => {
    nodeApi.saveSettings.mockResolvedValue(OPS);
    await go("access");
    expect(host.textContent).toContain("http://localhost:8787/auth/oidc/callback");
    expect(host.textContent).toContain("http://mac.local:8787/auth/oidc/callback");
    // Nothing to remove yet, and nothing to save until the issuer and client are named.
    expect(visibleButtons("Remove provider")).toHaveLength(0);
    expect(isDisabled(visibleButtons("Save")[0])).toBe(true);

    await typeInto(inputs("Issuer URL")[0], " https://id.example.com ");
    await typeInto(inputs("Client ID")[0], "stuga");
    await typeInto(inputs("Client secret")[0], "s3cret");
    // The button's default text follows the issuer being typed.
    expect(inputs("Button label")[0]!.placeholder).toBe("id.example.com");
    expect(inputs("Scopes")[0]!.placeholder).toBe("openid profile email");
    await click("Save");
    await settle();

    expect(nodeApi.saveSettings).toHaveBeenCalledWith({
      identity_provider: { issuer: "https://id.example.com", client_id: "stuga", label: "", scopes: "", client_secret: "s3cret" },
    });
  });

  it("keeps a stored secret unless it is replaced or removed", async () => {
    const configured: NodeOperationalSettings = {
      ...OPS,
      identity_provider: {
        ...OPS.identity_provider,
        issuer: "https://id.example.com",
        client_id: "stuga",
        label: "Okta",
        default_label: "id.example.com",
        client_secret_set: true,
        client_secret_label: "ab12cd34",
      },
    };
    nodeApi.settings.mockResolvedValue(configured);
    nodeApi.saveSettings.mockResolvedValue(configured);
    await renderWith(AI);
    await go("access");
    expect(inputs("Button label")[0]!.value).toBe("Okta");

    await click("Save");
    await settle();
    expect(nodeApi.saveSettings).toHaveBeenLastCalledWith({
      identity_provider: { issuer: "https://id.example.com", client_id: "stuga", label: "Okta", scopes: "" },
    });

    // The secret's own Remove comes before the provider's.
    await clickNth("Remove", 0);
    await click("Save");
    await settle();
    expect(nodeApi.saveSettings).toHaveBeenLastCalledWith({
      identity_provider: { issuer: "https://id.example.com", client_id: "stuga", label: "Okta", scopes: "", client_secret: "" },
    });
  });

  it("removes the identity provider only after saying who has no password, and how they get one", async () => {
    const configured: NodeOperationalSettings = {
      ...OPS,
      identity_provider: { ...OPS.identity_provider, issuer: "https://id.example.com", client_id: "stuga", accounts_without_password: 2 },
    };
    nodeApi.settings.mockResolvedValue(configured);
    nodeApi.saveSettings.mockResolvedValue(OPS);
    await renderWith(AI);
    await go("access");

    await click("Remove provider");
    expect(nodeApi.saveSettings).not.toHaveBeenCalled();
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "2 people have no password. Anyone still signed in can set one in Profile; the rest need a reset link.",
    );
    await confirmIn("Remove");
    await settle();
    expect(nodeApi.saveSettings).toHaveBeenCalledWith({ identity_provider: null });
    expect(visibleButtons("Remove provider")).toHaveLength(0);
  });

  it("asks before a different issuer drops every link, and not for a slash", async () => {
    const configured: NodeOperationalSettings = {
      ...OPS,
      identity_provider: { ...OPS.identity_provider, issuer: "https://id.example.com", client_id: "stuga", accounts_without_password: 2 },
    };
    nodeApi.settings.mockResolvedValue(configured);
    nodeApi.saveSettings.mockResolvedValue(configured);
    await renderWith(AI);
    await go("access");

    await typeInto(inputs("Issuer URL")[0], "https://id.example.com/");
    await click("Save");
    await settle();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(nodeApi.saveSettings).toHaveBeenCalledTimes(1);

    await typeInto(inputs("Issuer URL")[0], "https://sso.example.com");
    await click("Save");
    await settle();
    expect(nodeApi.saveSettings).toHaveBeenCalledTimes(1);
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "Everyone linked to the current provider has to link again. 2 people have no password. Anyone still signed in can set one in Profile; the rest need a reset link.",
    );
    await confirmIn("Change");
    await settle();
    expect(nodeApi.saveSettings).toHaveBeenLastCalledWith({
      identity_provider: { issuer: "https://sso.example.com", client_id: "stuga", label: "", scopes: "" },
    });
  });

  it("shows no sign-in mode among the node's facts", async () => {
    await go("about");
    expect(host.textContent).not.toContain("Sign-in");
  });

  it("lists in About what agents call the node and its id, with no name to edit there", async () => {
    await go("about");
    expect(inputs("Name")).toHaveLength(0);
    expect(host.textContent).toContain("Known to agents as");
    expect(host.textContent).toContain("localhost");
    expect(host.textContent).toContain("Node ID");
    expect(host.textContent).toContain("k3q7m2x9vbn4ha5z");
  });

  it("names Stuga's license in About and links the licenses of the packages the web app bundles", async () => {
    await go("about");
    expect(host.textContent).toContain("AGPL-3.0-only");
    const link = [...host.querySelectorAll("a")].find((a) => isShown(a) && a.textContent?.includes("Third-party licenses"));
    expect(link?.getAttribute("href")).toBe("/third-party-licenses.txt");
  });

  it("links in About the code the running build was made from", async () => {
    nodeApi.version.mockResolvedValue(RELEASE);
    await go("about");
    const link = [...host.querySelectorAll("a")].find((a) => isShown(a) && a.textContent?.includes("Source code"));
    expect(link?.getAttribute("href")).toBe("https://github.com/stuga-dev/stuga/tree/v1.9.0");
  });

  it("says a build from source has nothing to compare with, and offers no switch for it", async () => {
    await go("about");
    expect(host.textContent).toContain("0.0.0-dev · built from source");
    expect(host.textContent).toContain("Built from source: update the checkout and rebuild.");
    expect([...host.querySelectorAll('input[role="switch"]')].filter(isShown)).toHaveLength(0);
  });

  it("dates the running release, which is all a node with no way out knows about its age", async () => {
    nodeApi.version.mockResolvedValue(RELEASE);
    await remount();
    await go("about");
    expect(host.textContent).toContain("1.9.0 · released Nov 3, 2026");
    expect(host.textContent).toContain("Up to date. Checked just now.");
  });

  it("names a newer release, how this packaging upgrades, and where its notes are", async () => {
    nodeApi.version.mockResolvedValue({ ...RELEASE, update: { ...RELEASE.update, available: NEWER } });
    await remount();
    await go("about");
    expect(host.textContent).toContain("Stuga 1.10.0 is available");
    expect(host.textContent).toContain("Run ./stuga upgrade.");
    const notes = [...host.querySelectorAll("a")].find((a) => a.textContent === "Release notes");
    expect(notes?.getAttribute("href")).toBe(NEWER.notes_url);
    expect(notes?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(host.querySelector('.astryx-banner[data-status="info"]')?.textContent).toContain("Stuga 1.10.0 is available");
  });

  it("offers Update now where the machine installs releases, and asks first", async () => {
    const offered = { ...RELEASE, update: { ...RELEASE.update, available: NEWER, install: { available: true, status: null } } };
    nodeApi.version.mockResolvedValue(offered);
    nodeApi.installVersion.mockResolvedValue(offered);
    await remount();
    await go("about");
    expect(host.textContent).toContain("The node backs up, installs it and restarts.");
    expect(host.textContent).not.toContain("Run ./stuga upgrade.");
    await click("Update now");
    expect(nodeApi.installVersion).not.toHaveBeenCalled();
    await confirmIn("Update");
    await settle();
    expect(nodeApi.installVersion).toHaveBeenCalledWith("1.10.0");
    expect(host.textContent).toContain("Stuga 1.10.0… The node backs up first, then restarts.");
  });

  it("offers no Update now where the packaging upgrades another way", async () => {
    nodeApi.version.mockResolvedValue({ ...RELEASE, update: { ...RELEASE.update, available: NEWER } });
    await remount();
    await go("about");
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent === "Update now")).toHaveLength(0);
  });

  it("raises a release that fixes a vulnerability as a warning", async () => {
    nodeApi.version.mockResolvedValue({ ...RELEASE, update: { ...RELEASE.update, available: { ...NEWER, security: true } } });
    await remount();
    await go("about");
    expect(host.querySelector('.astryx-banner[data-status="warning"]')?.textContent).toContain("Security update: Stuga 1.10.0");
  });

  it("says why the last look failed", async () => {
    nodeApi.version.mockResolvedValue({ ...RELEASE, update: { ...RELEASE.update, error: "could not reach github.com" } });
    await remount();
    await go("about");
    expect(host.textContent).toContain("Couldn’t check: could not reach github.com.");
  });

  it("turns the look for new versions off at once, with nothing left to look with", async () => {
    nodeApi.version.mockResolvedValue(RELEASE);
    nodeApi.saveSettings.mockResolvedValue({ ...OPS, updates: { check: false } });
    await remount();
    await go("about");
    await flip("Check for new versions");
    expect(nodeApi.saveSettings).toHaveBeenCalledWith({ updates: { check: false } });
    expect(nodeApi.checkVersion).not.toHaveBeenCalled();
    expect([...host.querySelectorAll("button")].some((b) => isShown(b) && b.textContent === "Check now")).toBe(false);
    // Still a way to see what is out, from a browser that can: a node that cannot look is why the switch is off.
    const all = [...host.querySelectorAll("a")].find((a) => isShown(a) && a.textContent === "All releases");
    expect(all?.getAttribute("href")).toBe("https://github.com/stuga-dev/stuga/releases");
    expect(all?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says a build that is no release has nothing to compare with", async () => {
    nodeApi.version.mockResolvedValue({ ...SOURCE, version: "0.0.0-ci", build: "release" });
    await remount();
    await go("about");
    expect(host.textContent).toContain("0.0.0-ci is not a release, so there is nothing to compare it with.");
  });

  it("looks as soon as the switch is turned on, and again on request", async () => {
    nodeApi.settings.mockResolvedValue({ ...OPS, updates: { check: false } });
    nodeApi.version.mockResolvedValue({ ...RELEASE, update: NO_UPDATE });
    nodeApi.saveSettings.mockResolvedValue(OPS);
    nodeApi.checkVersion.mockResolvedValue({ ...RELEASE, update: { ...RELEASE.update, available: NEWER } });
    await remount();
    await go("about");
    expect(host.textContent).toContain("Not checking.");

    await flip("Check for new versions");
    expect(nodeApi.saveSettings).toHaveBeenCalledWith({ updates: { check: true } });
    expect(nodeApi.checkVersion).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Stuga 1.10.0 is available");

    await click("Check now");
    expect(nodeApi.checkVersion).toHaveBeenCalledTimes(2);
  });

  it("lists the node's backups, one taken before an upgrade marked so, and where they are kept", async () => {
    await go("backups");
    expect(host.textContent).toContain("The newest 7, in /backups.");
    expect(host.textContent).toContain("12 MB");
    expect(host.textContent).toContain("before upgrading from 1.8.0");
    expect(host.textContent).toContain("Next: ");
  });

  it("turns the daily backup off, and moves its hour", async () => {
    nodeApi.saveSettings.mockResolvedValue({ ...OPS, backups: { auto: false, hour: 3 } });
    await go("backups");
    await flip("Back up every day");
    expect(nodeApi.saveSettings).toHaveBeenLastCalledWith({ backups: { auto: false } });

    nodeApi.saveSettings.mockResolvedValue({ ...OPS, backups: { auto: true, hour: 22 } });
    await flip("Back up every day");
    await choose("At", "22:00");
    expect(nodeApi.saveSettings).toHaveBeenLastCalledWith({ backups: { hour: 22 } });
  });

  it("warns when the last backup failed", async () => {
    nodeApi.backups.mockResolvedValue({ ...BACKUPS, error: "not enough disk at /backups" });
    await remount();
    await go("backups");
    expect(host.querySelector('.astryx-banner[data-status="warning"]')?.textContent).toContain("not enough disk at /backups");
  });

  it("starts a backup now and says so while the node pauses for it", async () => {
    nodeApi.backUpNow.mockResolvedValue({ started: true });
    await go("backups");
    await click("Back up now");
    expect(nodeApi.backUpNow).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Backing up…");
  });

  it("says why a backup waits to start", async () => {
    nodeApi.backups.mockResolvedValue({ ...BACKUPS, running: true, waiting: "a workspace is being imported or exported" });
    await remount();
    await go("backups");
    expect(host.textContent).toContain("Waiting to back up: a workspace is being imported or exported.");
  });

  it("saves the search languages, and says the index is rebuilding until the node is done", async () => {
    const rebuilding = { ...OPS, search: { ...OPS.search, languages: ["ko" as const], rebuilding: true } };
    nodeApi.saveSettings.mockResolvedValue(rebuilding);
    nodeApi.settings.mockResolvedValue(rebuilding);
    await go("search");
    expect(inputs("Korean")[0]!.checked).toBe(false);
    expect(host.textContent).not.toContain("Rebuilding the search index");
    // Under the heading, once, and not as the list's description, which its hidden label hides too.
    expect(host.textContent!.split("Chinese, Japanese and English need nothing extra.")).toHaveLength(2);
    expect(host.querySelector('[role="group"][aria-describedby]')).toBeNull();

    vi.useFakeTimers();
    try {
      const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
      await act(async () => inputs("Korean")[0]!.click());
      await click("Save");
      await wait(0);
      expect(nodeApi.saveSettings).toHaveBeenCalledWith({ search: { languages: ["ko"] } });
      expect(inputs("Korean")[0]!.checked).toBe(true);
      expect(host.textContent).toContain("Rebuilding the search index");
      // A status a screen reader announces, named by the words shown; aria-labelledby wins over aria-label.
      const statuses = [...host.querySelectorAll('[role="status"]')].map(
        (el) => document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent ?? el.getAttribute("aria-label"),
      );
      expect(statuses).toContain("Rebuilding the search index…");

      await wait(2000);
      expect(nodeApi.settings).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain("Rebuilding the search index");

      nodeApi.settings.mockResolvedValue({ ...rebuilding, search: { ...rebuilding.search, rebuilding: false } });
      await wait(2000);
      expect(nodeApi.settings).toHaveBeenCalledTimes(3);
      expect(host.textContent).not.toContain("Rebuilding the search index");
      await wait(10_000);
      expect(nodeApi.settings).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a rebuild is running when Search opens during one", async () => {
    nodeApi.settings.mockResolvedValue({ ...OPS, search: { ...OPS.search, languages: ["ar"], rebuilding: true } });
    await remount();
    await go("search");
    expect(inputs("Arabic")[0]!.checked).toBe(true);
    expect(host.textContent).toContain("Rebuilding the search index");
    // A ring on Save's line, named by the words beside it rather than stacked over them.
    const ring = host.querySelector<HTMLElement>('[role="status"][aria-labelledby]')!;
    const words = document.getElementById(ring.getAttribute("aria-labelledby")!)!;
    expect(words.textContent).toBe("Rebuilding the search index…");
    expect(ring.nextElementSibling).toBe(words);
  });

  it("says why the last rebuild gave up, until the next one starts", async () => {
    const failed = { ...OPS, search: { ...OPS.search, languages: ["ko" as const], error: "could not extend file: No space left on device" } };
    nodeApi.settings.mockResolvedValue(failed);
    await remount();
    await go("search");
    expect(host.textContent).toContain("The search index wasn’t rebuilt");
    expect(host.textContent).toContain("No space left on device");

    nodeApi.saveSettings.mockResolvedValue({ ...failed, search: { ...failed.search, rebuilding: true, error: null } });
    await click("Save");
    expect(nodeApi.saveSettings).toHaveBeenCalledWith({ search: { languages: ["ko"] } });
    expect(host.textContent).not.toContain("The search index wasn’t rebuilt");
    expect(host.textContent).toContain("Rebuilding the search index");
  });

  it("opens Branding on an unnamed node with the product's name as the placeholder and in the preview", async () => {
    await go("branding");
    expect(inputs("Name")[0]!.value).toBe("");
    expect(inputs("Name")[0]!.placeholder).toBe("Stuga");
    expect(host.textContent).toContain("Stuga");
  });

  it("names the node under Branding, and the brand slot, the tab and the switcher's label follow without a reload", async () => {
    setAuthConfigForTest({ nodeName: null, nodeLabel: "localhost", branding: { accentColor: "#7c3aed" } });
    nodeApi.saveSettings.mockResolvedValue({
      ...OPS,
      node_name: "Liv’s Mac",
      node_label: "Liv’s Mac",
      branding: { accent_color: "#7c3aed" },
    });
    await go("branding");
    await typeInto(inputs("Name")[0], "  Liv’s Mac ");
    await click("Save");
    await settle();

    expect(nodeApi.saveSettings).toHaveBeenCalledWith({ node_name: "Liv’s Mac", branding: { accent_color: "" } });
    expect(nodeName()).toBe("Liv’s Mac");
    expect(nodeLabel()).toBe("Liv’s Mac");
    expect(brandingConfig().accentColor).toBe("#7c3aed");
    expect(document.title).toBe("Liv’s Mac");
    expect(inputs("Name")[0]!.value).toBe("Liv’s Mac");

    // Emptied, the app goes back to the product's name, and the label to the host.
    nodeApi.saveSettings.mockResolvedValue(OPS);
    await typeInto(inputs("Name")[0], "");
    await click("Save");
    await settle();
    expect(nodeApi.saveSettings).toHaveBeenLastCalledWith({ node_name: "", branding: { accent_color: "#7c3aed" } });
    expect(nodeName()).toBe("Stuga");
    expect(nodeLabel()).toBe("localhost");
    expect(document.title).toBe("Stuga");
    expect(inputs("Name")[0]!.value).toBe("");
  });

  it("says as it is typed why a name would be refused, and saves nothing until it is fixed", async () => {
    await go("branding");
    for (const [value, says] of [
      ["\u200b\u2060", "Use at least one visible character."],
      ["Liv\u202e’s Mac", "Remove the hidden control characters."],
      ["x".repeat(81), "Use up to 80 characters."],
    ] as const) {
      await typeInto(inputs("Name")[0], value);
      expect(host.textContent).toContain(says);
      expect(isDisabled(visibleButtons("Save")[0])).toBe(true);
      await pressEnter(inputs("Name")[0]);
    }
    expect(nodeApi.saveSettings).not.toHaveBeenCalled();

    // Emptied, the node goes unnamed, which is always allowed.
    await typeInto(inputs("Name")[0], "");
    expect(isDisabled(visibleButtons("Save")[0])).toBe(false);
  });

  it("saves the name and the colour in one go, and offers no logo of the node's own", async () => {
    nodeApi.saveSettings.mockResolvedValue(OPS);
    await go("branding");
    expect(visibleButtons("Upload logo")).toHaveLength(0);
    await click("Save");
    await settle();
    expect(nodeApi.saveSettings).toHaveBeenCalledWith({ node_name: "", branding: { accent_color: "" } });
  });

  it("names only notifications the node actually sends", async () => {
    await go("notifications");
    expect(host.textContent).toContain("Send shares, requests, comments and agent edits outside the app.");
    expect(host.textContent).not.toMatch(/mention/i);
  });

  it("shows only the section the URL names", async () => {
    expect(visibleButtons("Connect another provider")).toHaveLength(1);
    expect(inputs("Name")).toHaveLength(0);
    await go("branding");
    expect(visibleButtons("Connect another provider")).toHaveLength(0);
    expect(inputs("Name")).toHaveLength(1);
  });
});
