// @vitest-environment jsdom
/** The workspace's Agents page: its title, and webhooks told in plain words with the signing details folded away. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { mountInto, typeInto } from "../../test/form-input";

const webhooks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../api", async (orig) => {
  const api = await orig<typeof import("../../api")>();
  return {
    ...api,
    Folders: { ...api.Folders, list: vi.fn().mockResolvedValue({ folders: [] }) },
    Webhooks: { ...api.Webhooks, list: webhooks.list, create: webhooks.create, remove: webhooks.remove },
  };
});
vi.mock("@astryxdesign/core/Toast", () => import("../../test/toast"));
vi.mock("./SettingsLayout", () => ({
  useSettingsScope: () => ({
    isReady: true,
    canManage: true,
    workspace: {
      workspace_id: "ws1",
      name: "Liv's team",
      role: "admin",
      default_doc_access: "workspace_edit",
      agent_instructions: "",
      created_at: "2026-09-01T00:00:00Z",
    },
    reload: vi.fn(),
  }),
}));

const { AgentSettings } = await import("./AgentSettings");

const CHANNEL = {
  webhook_id: "whk_slack",
  kind: "slack",
  url: "https://hooks.slack.com/services/T/B/x",
  events: [],
  folder_id: null,
  active: true,
  created_by: "liv",
  created_at: "2026-10-01T00:00:00Z",
  last_delivery_at: null,
  last_status: null,
  failures: 0,
};

beforeEach(() => {
  webhooks.list.mockResolvedValue({ webhooks: [], event_types: ["doc.created", "comment.added"] });
});

async function open() {
  const { host, root } = mountInto();
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AgentSettings />
      </MemoryRouter>,
    );
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return host;
}

describe("AgentSettings", () => {
  it("is titled as the rail names it", async () => {
    const host = await open();
    expect([...host.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Agents"]);
  });

  it("says what webhooks do in one plain line, with how requests are signed under Advanced", async () => {
    const host = await open();
    expect(host.textContent).toContain("Send workspace events to another app.");
    const advanced = [...host.querySelectorAll("button, summary")].find((el) => el.textContent?.includes("Advanced"));
    expect(advanced).toBeTruthy();
    expect(advanced!.getAttribute("aria-expanded")).not.toBe("true");
    // The add form names its fields plainly; an empty Events means every event, which its placeholder says.
    expect(host.textContent).not.toContain("empty = all");
    expect(host.textContent).toContain("All events");
  });
});

describe("the Slack review channel", () => {
  it("adds a channel for the whole workspace from its address alone, and lists it apart from the webhooks", async () => {
    webhooks.create.mockResolvedValue({ webhook: CHANNEL, secret: "s" });
    const host = await open();
    expect(host.textContent).toContain("Post each AI change that waits for a colleague to Slack");
    const field = [...host.querySelectorAll("input")].find((i) => i.getAttribute("placeholder")?.startsWith("https://hooks.slack.com"));
    await typeInto(field, " https://hooks.slack.com/services/T/B/x ");
    webhooks.list.mockResolvedValue({ webhooks: [CHANNEL], event_types: [] });
    const add = [...host.querySelectorAll("button")].find((b) => b.textContent === "Add channel")!;
    await act(async () => add.click());
    expect(webhooks.create).toHaveBeenCalledExactlyOnceWith({ kind: "slack", url: "https://hooks.slack.com/services/T/B/x", events: [], folder_id: null });
    expect(host.textContent).toContain("Slack · Whole workspace");
    // Its signing secret means nothing to Slack, so none is shown, and the webhook list stays empty.
    expect(host.textContent).not.toContain("Copy the secret");
    expect(host.textContent).toContain("No webhooks yet.");
  });
});

