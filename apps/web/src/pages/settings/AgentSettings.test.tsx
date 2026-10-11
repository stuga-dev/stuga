// @vitest-environment jsdom
/** The workspace's Agents page: its title, and webhooks told in plain words with the signing details folded away. */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { mountInto } from "../../test/form-input";

vi.mock("../../api", async (orig) => {
  const api = await orig<typeof import("../../api")>();
  return {
    ...api,
    Folders: { ...api.Folders, list: vi.fn().mockResolvedValue({ folders: [] }) },
    Webhooks: { ...api.Webhooks, list: vi.fn().mockResolvedValue({ webhooks: [], event_types: ["doc.created", "comment.added"] }) },
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
