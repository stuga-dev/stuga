// @vitest-environment jsdom
/** Workspace settings' Export section: who sees it, the download it starts, and its busy state. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const workspaces = vi.hoisted(() => ({ exportArchive: vi.fn() }));
const scope = vi.hoisted(() => ({ canManage: true, isOwner: false }));
const saved = vi.hoisted(() => ({ files: [] as Array<{ blob: Blob; filename: string }> }));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type?: string }> }));

vi.mock("../../api", async (orig) => {
  const api = await orig<typeof import("../../api")>();
  return { ...api, Workspaces: { ...api.Workspaces, ...workspaces } };
});
vi.mock("../../lib/download", () => ({
  saveBlob: (blob: Blob, filename: string) => saved.files.push({ blob, filename }),
}));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type?: string }) => toasts.shown.push(t),
}));
vi.mock("./SettingsLayout", () => ({
  useSettingsScope: () => ({
    isReady: true,
    workspace: {
      workspace_id: "ws1",
      name: "Liv's team",
      role: scope.canManage ? "admin" : "member",
      default_doc_access: "workspace_edit",
      agent_instructions: "",
      created_at: "2026-09-01T00:00:00Z",
    },
    reload: vi.fn(),
    ...scope,
  }),
}));

const { WorkspaceGeneral } = await import("./WorkspaceGeneral");

let host: HTMLDivElement;
let root: Root;

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
const headings = () => [...host.querySelectorAll("h2")].map((h) => h.textContent);

async function open() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <WorkspaceGeneral />
      </MemoryRouter>,
    );
  });
  await settle();
}

async function click(label: string) {
  const el = button(label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  workspaces.exportArchive.mockReset();
  scope.canManage = true;
  scope.isOwner = false;
  saved.files = [];
  toasts.shown = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("WorkspaceGeneral · Export", () => {
  it("downloads the archive for an admin, busy until it arrives", async () => {
    let arrive!: (file: { blob: Blob; filename: string }) => void;
    workspaces.exportArchive.mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    await open();
    expect(headings()).toContain("Export");

    await click("Export workspace");
    expect(workspaces.exportArchive).toHaveBeenCalledWith("ws1");
    expect(button("Export workspace")?.disabled).toBe(true);
    expect(saved.files).toEqual([]);

    const blob = new Blob(["zip"], { type: "application/zip" });
    await act(async () => arrive({ blob, filename: "Liv's team.stuga.zip" }));
    await settle();
    expect(saved.files).toEqual([{ blob, filename: "Liv's team.stuga.zip" }]);
    expect(button("Export workspace")?.disabled).toBe(false);
  });

  it("says why when the export fails", async () => {
    workspaces.exportArchive.mockRejectedValue(new Error("the node is busy"));
    await open();
    await click("Export workspace");
    await settle();
    expect(toasts.shown).toEqual([{ body: "the node is busy", type: "error" }]);
    expect(saved.files).toEqual([]);
  });

  it("is not offered to a member", async () => {
    scope.canManage = false;
    await open();
    expect(headings()).not.toContain("Export");
    expect(button("Export workspace")).toBeUndefined();
  });
});
