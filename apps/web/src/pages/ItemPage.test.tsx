// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { DocSummary } from "../api";

const docs = vi.hoisted(() => ({ get: vi.fn(), trash: vi.fn() }));

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Docs: docs }));
vi.mock("./DocPage", () => ({ DocPage: ({ doc }: { doc: DocSummary }) => <div data-testid="doc-page">{doc.title}</div> }));
vi.mock("./DatabasePage", () => ({ DatabasePage: ({ doc }: { doc: DocSummary }) => <div data-testid="database-page">{doc.title}</div> }));
vi.mock("../document/NoAccessCard", () => ({ NoAccessCard: () => <div data-testid="no-access" /> }));
// A value other than the shipped one, so a hardcoded retention period in the copy fails.
vi.mock("@stuga/protocol/domain/limits", async (orig) => ({
  ...(await orig<typeof import("@stuga/protocol/domain/limits")>()),
  TRASH_RETENTION_DAYS: 7,
}));

const { ItemPage } = await import("./ItemPage");

function summary(over: Partial<DocSummary> = {}): DocSummary {
  return {
    doc_id: "d_1",
    title: "Plan",
    owner: "user:u_1",
    doc_type: "prose",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    trashed: false,
    trashed_at: null,
    parent_id: null,
    locked: false,
    search_hidden: false,
    agent_mode: "review",
    page_of: null,
    page_row: null,
    ...over,
  };
}

function failure(status: number): Error {
  return Object.assign(new Error("failed"), { status });
}

let host: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/doc/d_1"]}>
        <Routes>
          <Route path="/doc/:docId" element={<ItemPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const retryButton = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  docs.get.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ItemPage", () => {
  it("fetches the item once and hands the row to the document page", async () => {
    docs.get.mockResolvedValue(summary());
    await render();
    expect(byTestId("doc-page")?.textContent).toBe("Plan");
    expect(docs.get).toHaveBeenCalledTimes(1);
  });

  it("renders a database through the database page", async () => {
    docs.get.mockResolvedValue(summary({ doc_type: "database", title: "Tasks" }));
    await render();
    expect(byTestId("database-page")?.textContent).toBe("Tasks");
  });

  it("keeps a trashed database's grid unmounted and states the trash retention period", async () => {
    docs.get.mockResolvedValue(summary({ doc_type: "database", title: "Tasks", trashed: true }));
    await render();
    expect(byTestId("database-page")).toBeNull();
    expect(host.textContent).toContain("This database is in Trash");
    expect(host.textContent).toContain("deleted permanently after 7 days.");
  });

  it("shows the no-access card for a 403 or a 404", async () => {
    for (const status of [403, 404]) {
      docs.get.mockRejectedValueOnce(failure(status));
      await render();
      expect(byTestId("no-access")).not.toBeNull();
      expect(retryButton()).toBeUndefined();
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it("offers a retry for a server or network failure instead of loading forever", async () => {
    docs.get.mockRejectedValueOnce(failure(503)).mockResolvedValueOnce(summary());
    await render();
    expect(host.textContent).toContain("Couldn’t open this item");
    expect(byTestId("no-access")).toBeNull();

    await act(async () => {
      retryButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(docs.get).toHaveBeenCalledTimes(2);
    expect(byTestId("doc-page")?.textContent).toBe("Plan");
  });

  it("treats a timeout with no status as a failure to retry", async () => {
    docs.get.mockRejectedValueOnce(new Error("The server didn’t respond in time."));
    await render();
    expect(retryButton()).toBeDefined();
  });
});
