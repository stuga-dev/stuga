// @vitest-environment jsdom
/** Workspace settings' Export section: who sees it, the download it starts, and its busy state. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { toasts } from "../../test/toast";
import { mountInto, typeInto } from "../../test/form-input";
import { takeNotice } from "../../lib/session/notice";

const workspaces = vi.hoisted(() => ({ exportArchive: vi.fn(), deleteWorkspace: vi.fn() }));
const scope = vi.hoisted(() => ({ canManage: true, isOwner: false, isNodeAdmin: false }));
const saved = vi.hoisted(() => ({ files: [] as Array<{ blob: Blob; filename: string }> }));

vi.mock("../../api", async (orig) => {
  const api = await orig<typeof import("../../api")>();
  return { ...api, Workspaces: { ...api.Workspaces, ...workspaces } };
});
vi.mock("../../lib/download", () => ({
  saveBlob: (blob: Blob, filename: string) => saved.files.push({ blob, filename }),
}));
vi.mock("@astryxdesign/core/Toast", () => import("../../test/toast"));
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
/** The input a visible label names. */
const fieldLabelled = (text: string) => {
  const label = [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith(text));
  return label ? host.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`) : null;
};

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
  workspaces.exportArchive.mockReset();
  workspaces.deleteWorkspace.mockReset();
  scope.canManage = true;
  scope.isOwner = false;
  scope.isNodeAdmin = false;
  saved.files = [];
  toasts.shown = [];
  ({ host, root } = mountInto());
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
    expect(toasts.shown).toEqual([{ body: "Exported Liv's team.stuga.zip.", type: "info" }]);
  });

  it("says what the archive holds, and points a node administrator at Backups", async () => {
    await open();
    expect(host.textContent).toContain("Documents, databases, files and comments, in one .stuga.zip.");
    expect(host.textContent).not.toContain("Backups");
    await act(async () => root.unmount());
    ({ host, root } = mountInto());
    scope.isNodeAdmin = true;
    await open();
    expect(host.textContent).toContain("For a full backup with version history, use Backups.");
  });

  it("says why when the export fails", async () => {
    workspaces.exportArchive.mockRejectedValue(new Error("the node is busy"));
    await open();
    await click("Export workspace");
    await settle();
    expect(toasts.shown).toEqual([{ body: "the node is busy", type: "error" }]);
    expect(saved.files).toEqual([]);
  });

  it("leaves a notice that the workspace was deleted, for the page the app reloads to", async () => {
    scope.isOwner = true;
    workspaces.deleteWorkspace.mockResolvedValue({ deleted: true, docs: 3 });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    await open();
    const confirm = fieldLabelled("Type “Liv's team” to confirm")!;
    await typeInto(confirm, "Liv's team");
    await click("Delete workspace");
    await settle();
    expect(workspaces.deleteWorkspace).toHaveBeenCalledWith("ws1", "Liv's team");
    expect(assign).toHaveBeenCalledWith("/");
    expect(takeNotice()).toBe("Deleted “Liv's team”.");
    vi.unstubAllGlobals();
  });

  it("asks for the name with a label, not a placeholder that reads as already typed", async () => {
    scope.isOwner = true;
    await open();
    const confirm = fieldLabelled("Type “Liv's team” to confirm");
    expect(confirm).toBeTruthy();
    expect(confirm!.placeholder).toBe("");
    expect(confirm!.value).toBe("");
    expect(button("Delete workspace")?.disabled).toBe(true);
  });

  it("names the access choice as creating a workspace does", async () => {
    await open();
    expect(fieldLabelled("Access for new documents") ?? host.querySelector("[aria-label='Access for new documents']")).toBeTruthy();
    expect(host.textContent).toContain("Access for new documents");
  });

  it("is not offered to a member", async () => {
    scope.canManage = false;
    await open();
    expect(headings()).not.toContain("Export");
    expect(button("Export workspace")).toBeUndefined();
  });
});
