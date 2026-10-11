// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { mountInto } from "../test/form-input";
import { toasts } from "../test/toast";

const docs = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("../api", () => ({ Docs: docs }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

const { ItemTitle, useTitleRename } = await import("./ItemTitle");

type Rename = ReturnType<typeof useTitleRename>;
let current!: Rename;
let root: Root;
let host: HTMLDivElement;

interface ProbeProps {
  serverTitle?: string;
  readOnly?: boolean;
  onError?: (e: unknown) => void;
}

function Probe({ serverTitle = "Plan", readOnly = false, onError }: ProbeProps) {
  current = useTitleRename("d_1", serverTitle, readOnly, onError);
  return null;
}

function RenamedProbe({ onRenamed }: { onRenamed: (doc: unknown) => void }) {
  current = useTitleRename("d_1", "Plan", false, undefined, onRenamed);
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
  ({ root, host } = mountInto());
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

  it("keeps its rename until the server's title moves, then shows the server's", async () => {
    docs.rename.mockResolvedValue({});
    await mount();
    await typeAndCommit("Launch plan");
    expect(current.title).toBe("Launch plan");
    // Someone renamed it after: everyone sees the title that won.
    await mount({ serverTitle: "Lin's plan" });
    expect(current.title).toBe("Lin's plan");
  });

  it("hands the renamed row on, with when the rename was sent", async () => {
    docs.rename.mockResolvedValue({ doc_id: "d_1", title: "Launch plan", title_source: "user" });
    const onRenamed = vi.fn();
    current = undefined as unknown as Rename;
    await act(async () => root.render(<RenamedProbe onRenamed={onRenamed} />));
    await typeAndCommit("Launch plan");
    expect(onRenamed).toHaveBeenCalledWith(expect.objectContaining({ title: "Launch plan", title_source: "user" }), expect.any(Number));
  });

  it("says who won when a read after its own rename was answered finds another title", async () => {
    docs.rename.mockResolvedValue({});
    await mount();
    await typeAndCommit("Launch plan");
    const later = Date.now() + 1;
    act(() => current.noteRenamedBy("Launch plan", "Liv", later));
    expect(toasts.shown).toEqual([]);
    act(() => current.noteRenamedBy("Oven rota", "Liv", later));
    expect(toasts.shown).toEqual([{ body: "Liv renamed it to “Oven rota”.", type: "info" }]);
    // Said once; a later rename by someone else is just the new title.
    act(() => current.noteRenamedBy("Bread", "Bo", later));
    expect(toasts.shown).toHaveLength(1);
  });

  it("says nothing on a read asked before its own rename was answered, which that rename may still overtake", async () => {
    docs.rename.mockResolvedValue({});
    await mount();
    const before = Date.now() - 1;
    await typeAndCommit("Launch plan");
    act(() => current.noteRenamedBy("Oven rota", "Liv", before));
    expect(toasts.shown).toEqual([]);
  });

  it("says nothing about a rename by someone else when it renamed nothing itself", async () => {
    await mount();
    act(() => current.noteRenamedBy("Oven rota", "Liv", Date.now()));
    expect(toasts.shown).toEqual([]);
  });

  it("goes back to following the server's title when a rename is refused", async () => {
    docs.rename.mockRejectedValue(new Error("The document is locked"));
    await mount();
    await typeAndCommit("Other");
    await mount({ serverTitle: "Meeting notes" });
    expect(current.title).toBe("Meeting notes");
  });
});

describe("ItemTitle", () => {
  function Header({ serverTitle }: { serverTitle: string }) {
    const rename = useTitleRename("d_1", serverTitle, false);
    return <ItemTitle rename={rename} readOnly={false} label="Title" />;
  }

  async function openField(serverTitle: string): Promise<HTMLInputElement> {
    await act(async () => root.render(<Header serverTitle={serverTitle} />));
    await act(async () => host.querySelector("button")!.click());
    return host.querySelector("input")!;
  }

  it("opens a title with all of it selected, so typing replaces it", async () => {
    const field = await openField("Bakery handbook");
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Bakery handbook");
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("Bakery handbook".length);
  });

  it("opens an untitled item empty, with Untitled only as the placeholder", async () => {
    const field = await openField("");
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("Untitled");
  });
});
