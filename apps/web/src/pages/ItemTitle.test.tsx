// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { mountInto } from "../test/form-input";
import { toasts } from "../test/toast";

const docs = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("../api", () => ({ Docs: docs }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

const { useTitleRename } = await import("./ItemTitle");

type Rename = ReturnType<typeof useTitleRename>;
let current!: Rename;
let root: Root;

interface ProbeProps {
  serverTitle?: string;
  readOnly?: boolean;
  onError?: (e: unknown) => void;
}

function Probe({ serverTitle = "Plan", readOnly = false, onError }: ProbeProps) {
  current = useTitleRename("d_1", serverTitle, readOnly, onError);
  return null;
}

async function mount(props: ProbeProps = {}) {
  await act(async () => root.render(<Probe {...props} />));
}

async function typeAndCommit(title: string) {
  await act(async () => {
    current.startEditing();
    current.setTitle(title);
  });
  await act(async () => {
    await current.commit();
  });
}

beforeEach(() => {
  docs.rename.mockReset();
  toasts.shown = [];
  ({ root } = mountInto());
});

describe("useTitleRename", () => {
  it("sends a changed title and keeps it", async () => {
    docs.rename.mockResolvedValue({});
    await mount();
    await typeAndCommit("  Launch plan ");
    expect(docs.rename).toHaveBeenCalledWith("d_1", "Launch plan");
    expect(current.title).toBe("Launch plan");
    expect(current.editing).toBe(false);
    expect(toasts.shown).toEqual([]);
  });

  it("does not send an unchanged title, which would stop heading sync", async () => {
    await mount();
    await typeAndCommit("Plan ");
    expect(docs.rename).not.toHaveBeenCalled();
  });

  it("snaps back when the title is blank or the item is read-only", async () => {
    await mount();
    await typeAndCommit("   ");
    expect(current.title).toBe("Plan");
    await mount({ readOnly: true });
    await typeAndCommit("Other");
    expect(current.title).toBe("Plan");
    expect(docs.rename).not.toHaveBeenCalled();
  });

  it("snaps back, reports a refused rename and shows the refusal", async () => {
    const refusal = Object.assign(new Error("Only the owner can rename this"), { status: 403 });
    docs.rename.mockRejectedValue(refusal);
    const onError = vi.fn();
    await mount({ onError });
    await typeAndCommit("Other");
    expect(onError).toHaveBeenCalledWith(refusal);
    expect(toasts.shown).toEqual([{ body: "Only the owner can rename this", type: "error" }]);
    expect(current.title).toBe("Plan");
  });

  it("shows the refusal without an error handler", async () => {
    docs.rename.mockRejectedValue(new Error("The document is locked"));
    await mount();
    await typeAndCommit("Other");
    expect(toasts.shown).toEqual([{ body: "The document is locked", type: "error" }]);
    expect(current.title).toBe("Plan");
  });

  it("follows the server's title, Untitled while it is empty", async () => {
    await mount({ serverTitle: "" });
    expect(current.title).toBe("Untitled");
    await mount({ serverTitle: "Meeting notes" });
    expect(current.title).toBe("Meeting notes");
  });

  it("keeps what is being typed when the server's title changes", async () => {
    docs.rename.mockResolvedValue({});
    await mount({ serverTitle: "" });
    await act(async () => {
      current.startEditing();
      current.setTitle("Agenda");
    });
    await mount({ serverTitle: "Meeting notes" });
    expect(current.title).toBe("Agenda");
    await act(async () => {
      await current.commit();
    });
    expect(docs.rename).toHaveBeenCalledWith("d_1", "Agenda");
    expect(current.title).toBe("Agenda");
  });

  it("keeps a rename over a later server title", async () => {
    docs.rename.mockResolvedValue({});
    await mount();
    await typeAndCommit("Launch plan");
    await mount({ serverTitle: "Plan, derived again" });
    expect(current.title).toBe("Launch plan");
  });

  it("goes back to following the server's title when a rename is refused", async () => {
    docs.rename.mockRejectedValue(new Error("The document is locked"));
    await mount();
    await typeAndCommit("Other");
    await mount({ serverTitle: "Meeting notes" });
    expect(current.title).toBe("Meeting notes");
  });
});
