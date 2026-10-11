// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { mountInto } from "../test/form-input";
import { membershipEnded } from "../lib/session/endings";
import { getActiveWorkspace, rememberWorkspaceName, setActiveWorkspace } from "../lib/session/workspace-pointer";

const docs = vi.hoisted(() => ({ trash: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Docs: docs }));
const copied = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("../lib/clipboard", () => ({
  copyText: async (text: string) => {
    copied.text = text;
    return true;
  },
}));

const { EndedBanner, TrashedBanner } = await import("./ItemStateBanner");

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
}

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

async function press(label: string): Promise<void> {
  await act(async () => button(label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  docs.trash.mockReset();
  copied.text = null;
  ({ host, root } = mountInto());
});

describe("a document in the trash", () => {
  it("offers Restore to someone who may write it, and hands back the restored row", async () => {
    const restored = { doc_id: "d_1", trashed: false };
    docs.trash.mockResolvedValue(restored);
    const onRestored = vi.fn();
    await render(<TrashedBanner docId="d_1" canRestore onRestored={onRestored} />);
    expect(host.textContent).toContain("This document is in Trash");
    await press("Restore");
    expect(docs.trash).toHaveBeenCalledWith("d_1", false);
    expect(onRestored).toHaveBeenCalledWith(restored);
  });

  it("offers no Restore to a reader", async () => {
    await render(<TrashedBanner docId="d_1" canRestore={false} onRestored={() => {}} />);
    expect(button("Restore")).toBeUndefined();
  });
});

describe("an open item whose syncing ended", () => {
  it("says the document was deleted and copies the text still on screen", async () => {
    await render(<EndedBanner why="deleted" noun="document" textToCopy={() => "# Plan\n\nKeep me."} />);
    expect(host.textContent).toContain("This document was deleted");
    await press("Copy text");
    expect(copied.text).toBe("# Plan\n\nKeep me.");
  });

  it("names the workspace a removed member left, and carries that to the page they land on", async () => {
    setActiveWorkspace("ws_1");
    rememberWorkspaceName("ws_1", "Bakery");
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    try {
      await render(<EndedBanner why="removed" noun="database" />);
      expect(host.textContent).toContain("You are no longer a member of Bakery");
      expect(button("Copy text")).toBeUndefined();
      await press("All documents");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(membershipEnded()).toBe("Bakery");
    expect(getActiveWorkspace()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/");
  });
});
