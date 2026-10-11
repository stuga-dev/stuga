// @vitest-environment jsdom
/** Download as Markdown, Print and Make a copy, from a document's ⋯ menu or a library row. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { DocSummary } from "../api";
import { toastBodies, toasts } from "../test/toast";
import { mountInto } from "../test/form-input";

const docs = vi.hoisted(() => ({ markdown: vi.fn(), copy: vi.fn() }));
const saved = vi.hoisted(() => ({ saveBlob: vi.fn() }));
const nav = vi.hoisted(() => vi.fn());
const role = vi.hoisted(() => ({ current: "member" as string | null }));

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Docs: docs }));
vi.mock("../lib/download", () => saved);
vi.mock("../state/workspace-role", () => ({ useWorkspaceRole: () => role.current }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
vi.mock("react-router-dom", async (orig) => ({ ...(await orig<typeof import("react-router-dom")>()), useNavigate: () => nav }));

const { markdownFileName, useDocFileActions } = await import("./doc-file-actions");

const DOC: DocSummary = {
  doc_id: "d_1",
  title: "Bread: plan",
  title_source: "user",
  owner: "user:u_2",
  doc_type: "prose",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  trashed: false,
  trashed_at: null,
  parent_id: "f_1",
  locked: false,
  search_hidden: false,
  agent_mode: "review",
  page_of: null,
  page_row: null,
};

let actions: ReturnType<typeof useDocFileActions>;

function Probe({ openCopy }: { openCopy?: boolean }) {
  actions = useDocFileActions({ openCopy });
  return null;
}

async function mount(openCopy?: boolean) {
  const { root } = mountInto();
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Probe openCopy={openCopy} />
      </MemoryRouter>,
    ),
  );
}

async function run(label: string, doc: DocSummary = DOC, print = false) {
  const item = actions.items(doc, { print }).find((x) => x.label === label);
  expect(item, label).toBeTruthy();
  await act(async () => item!.onClick());
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  role.current = "member";
  toasts.shown = [];
  docs.copy.mockResolvedValue({ ...DOC, doc_id: "d_2", title: "Copy of Bread: plan" });
});

describe("a document's file actions", () => {
  it("offers Print only on the open page, and nothing for a database", async () => {
    await mount();
    expect(actions.items(DOC).map((x) => x.label)).toEqual(["Download as Markdown", "Make a copy"]);
    expect(actions.items(DOC, { print: true }).map((x) => x.label)).toEqual(["Download as Markdown", "Print…", "Make a copy"]);
    expect(actions.items({ ...DOC, doc_type: "database" })).toEqual([]);
  });

  it("downloads the Markdown under a name every system accepts", async () => {
    docs.markdown.mockResolvedValue({ markdown: "Bread\n\n* [ ] Turn on ovens\n" });
    await mount();
    await run("Download as Markdown");
    const [blob, name] = saved.saveBlob.mock.calls[0]!;
    expect(name).toBe("Bread plan.md");
    expect(await (blob as Blob).text()).toBe("Bread\n\n* [ ] Turn on ovens\n");
    expect(markdownFileName("  ")).toBe("Untitled.md");
  });

  it("makes a copy beside the original and offers to open it", async () => {
    await mount();
    await run("Make a copy");
    expect(docs.copy).toHaveBeenCalledWith("d_1", "Copy of Bread: plan", "f_1");
    expect(toastBodies()).toEqual(["Made “Copy of Bread: plan”."]);
    expect(nav).not.toHaveBeenCalled();
  });

  it("opens the copy at once from the open page", async () => {
    await mount(true);
    await run("Make a copy");
    expect(nav).toHaveBeenCalledWith("/doc/d_2");
  });

  it("puts the copy at the top of the library when the folder is view-only", async () => {
    docs.copy.mockRejectedValueOnce(Object.assign(new Error("View-only access to the parent folder."), { status: 403, code: "view-only access to the parent folder" }));
    await mount();
    await run("Make a copy");
    expect(docs.copy.mock.calls.map((c) => c[2])).toEqual(["f_1", null]);
    expect(toastBodies()).toEqual(["Made “Copy of Bread: plan”."]);
  });

  it("puts the copy at the top of the library when the folder is out of sight, as a document shared on its own", async () => {
    docs.copy.mockRejectedValueOnce(Object.assign(new Error("Parent folder not found."), { status: 404, code: "parent folder not found" }));
    await mount();
    await run("Make a copy");
    expect(docs.copy.mock.calls.map((c) => c[2])).toEqual(["f_1", null]);
    expect(toastBodies()).toEqual(["Made “Copy of Bread: plan”."]);
  });

  it("offers a guest no copy, which they cannot make", async () => {
    role.current = "guest";
    await mount();
    expect(actions.items(DOC, { print: true }).map((x) => x.label)).toEqual(["Download as Markdown", "Print…"]);
  });

  it("says why a copy failed", async () => {
    docs.copy.mockRejectedValue(Object.assign(new Error("Guests can’t create documents in this workspace."), { status: 403, code: "guests cannot create documents in this workspace" }));
    await mount();
    await run("Make a copy");
    expect(docs.copy).toHaveBeenCalledTimes(1);
    expect(toastBodies()).toEqual(["Guests can’t create documents in this workspace."]);
  });
});
