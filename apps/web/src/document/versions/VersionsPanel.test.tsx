// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import { DOC_FLUSH_INTERVAL_MS } from "@stuga/protocol/domain/limits";
import type { Version, VersionListing } from "../../api";

const docs = vi.hoisted(() => ({
  versions: vi.fn(),
  versionContent: vi.fn(),
  restoreVersion: vi.fn(),
  deleteVersion: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type: string }> }));

vi.mock("../../api", () => ({ Docs: docs }));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type: string }) => toasts.shown.push(t),
}));

const { VersionsPanel } = await import("./VersionsPanel");

// jsdom's <dialog> has no showModal/close, which Astryx Dialog calls.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

/** Past the actor's snapshot interval and the index job's allowance. */
const SETTLED_MS = DOC_FLUSH_INTERVAL_MS + 10_000;
const MINUTE = 60_000;

function version(seq: number): Version {
  // No authors, so no name lookups.
  const ts = new Date(2026, 8, 25, 9, seq).toISOString();
  return { doc_id: "d_1", seq, ts, authors: [], chars: null, chars_added: null, chars_removed: null };
}

function listing(seqs: number[], head_seq: number, can_manage = true): VersionListing {
  return { versions: seqs.map(version), head_seq, can_manage };
}

/** A response the test settles by hand. */
function deferred() {
  let resolve!: (v: VersionListing) => void;
  const promise = new Promise<VersionListing>((r) => (resolve = r));
  return { promise, resolve };
}

let host: HTMLDivElement;
let root: Root;
let ydoc: Y.Doc;
let visibility: DocumentVisibilityState;

const rows = () => [...host.querySelectorAll<HTMLButtonElement>(".version-open")];
const current = () => [...host.querySelectorAll(".vcurrent")];
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);
/** A Button with a tooltip stays focusable when off, so it is aria-disabled rather than disabled. */
const isOff = (b: HTMLButtonElement | undefined) => b!.disabled || b!.getAttribute("aria-disabled") === "true";

async function mount(first: VersionListing) {
  docs.versions.mockResolvedValue(first);
  await act(async () => root.render(<VersionsPanel docId="d_1" ydoc={ydoc} />));
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}

async function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}

async function open(rowIndex: number) {
  await act(async () => rows()[rowIndex]!.click());
}

async function close() {
  await act(async () => button("Close")!.click());
}

/** Replaces the document with one paragraph and returns its Markdown, as the server would serialize it. */
function write(text: string): string {
  const fragment = ydoc.getXmlFragment("default");
  ydoc.transact(() => {
    fragment.delete(0, fragment.length);
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(text)]);
    fragment.insert(0, [p]);
  });
  return yXmlFragmentToMarkdown(fragment);
}

/** Each version's Markdown by seq. */
function contents(bySeq: Record<number, string>) {
  docs.versionContent.mockImplementation(async (_doc: string, seq: number) => ({ seq, text: bySeq[seq] ?? "" }));
}

/** Picks a "Compare with" option by position. */
async function compareWith(index: number) {
  const trigger = document.body.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => trigger.click());
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  await act(async () => listbox.querySelectorAll<HTMLElement>('[role="option"]')[index]!.click());
}

const dialogText = () => document.body.querySelector("dialog")?.textContent ?? "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  docs.versions.mockReset();
  docs.versionContent.mockReset().mockResolvedValue({ seq: 1, text: "Hello" });
  toasts.shown = [];
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  ydoc = new Y.Doc();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("VersionsPanel: Current", () => {
  it("labels the version the document loads from as current", async () => {
    await mount(listing([7, 6], 7));
    expect(current()).toHaveLength(1);
    expect(rows()[0]!.contains(current()[0]!)).toBe(true);
  });

  it("labels no version current when the document is ahead of every one", async () => {
    await mount(listing([7, 6], 9));
    expect(rows()).toHaveLength(2);
    expect(current()).toHaveLength(0);
  });

  it("keeps Delete off for the version the document loads from, and only for it", async () => {
    await mount(listing([7, 6], 7));
    await open(0);
    expect(isOff(button("Delete"))).toBe(true);
    await close();
    await open(1);
    expect(isOff(button("Delete"))).toBe(false);
  });

  it("labels the newest version current, with Delete off, while the indexed head trails it", async () => {
    // v12 recorded, its snapshot not indexed yet; the server refuses any seq at or past 8.
    await mount(listing([12, 8], 8));
    expect(current()).toHaveLength(1);
    expect(rows()[0]!.contains(current()[0]!)).toBe(true);
    await open(0);
    expect(isOff(button("Delete"))).toBe(true);
  });

  it("allows deleting the newest version once the document has moved past it", async () => {
    await mount(listing([7, 6], 9));
    await open(0);
    expect(isOff(button("Delete"))).toBe(false);
  });

  it("shows Restore and Delete only to someone who may use them", async () => {
    await mount(listing([7, 6], 9, true));
    await open(1);
    expect(button("Restore this version")).toBeDefined();
    expect(button("Delete")).toBeDefined();
    await close();

    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(listing([7, 6], 9, false));
    await open(1);
    expect(button("Close")).toBeDefined();
    expect(button("Restore this version")).toBeUndefined();
    expect(button("Delete")).toBeUndefined();
  });

  it("says who may restore when the server refuses", async () => {
    docs.restoreVersion.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    await mount(listing([7, 6], 7));
    await open(1);
    await act(async () => button("Restore this version")!.click());
    expect(toasts.shown).toEqual([
      { body: "Restore failed. Only the owner or a workspace admin can restore a version.", type: "error" },
    ]);
  });
});

describe("VersionsPanel: Current once the document has moved past every version", () => {
  it("labels the newest version current, with Delete off, while the text still matches it", async () => {
    // An edit undone, or a column resized: saved as seq 8 and 9, no version owed.
    contents({ 7: write("Hello") });
    await mount(listing([7, 6], 9));
    expect(docs.versionContent).toHaveBeenCalledWith("d_1", 7);
    expect(current()).toHaveLength(1);
    expect(rows()[0]!.contains(current()[0]!)).toBe(true);
    await open(0);
    expect(isOff(button("Delete"))).toBe(true);
    expect(dialogText()).toContain("No differences");
  });

  it("labels none current once the text differs, and follows later edits", async () => {
    contents({ 7: write("Hello") });
    await mount(listing([7, 6], 9));
    expect(current()).toHaveLength(1);

    // A fresh answer, as each real response is.
    docs.versions.mockResolvedValue(listing([7, 6], 9));
    write("Hello there");
    await advance(SETTLED_MS);
    expect(current()).toHaveLength(0);
    await open(0);
    expect(isOff(button("Delete"))).toBe(false);
  });

  it("reads the newest version's text once per seq", async () => {
    contents({ 7: write("Hello"), 10: "Hello" });
    await mount(listing([7, 6], 9));
    await advance(2 * MINUTE);
    expect(docs.versionContent).toHaveBeenCalledTimes(1);

    docs.versions.mockResolvedValue(listing([10, 7, 6], 11));
    await advance(MINUTE);
    expect(docs.versionContent).toHaveBeenCalledTimes(2);
    expect(docs.versionContent).toHaveBeenLastCalledWith("d_1", 10);
    expect(rows()[0]!.contains(current()[0]!)).toBe(true);
  });

  it("reads no text while the head is at the newest version", async () => {
    await mount(listing([7, 6], 7));
    expect(docs.versionContent).not.toHaveBeenCalled();
  });
});

describe("VersionsPanel: a version that leaves the listing", () => {
  it("closes the version being viewed once a refresh no longer lists it, and says so", async () => {
    await mount(listing([7, 6, 5], 9));
    await open(1);
    expect(button("Restore this version")).toBeDefined();

    // Retention dropped v6 when v8 was recorded.
    docs.versions.mockResolvedValue(listing([8, 7, 5], 9));
    await advance(MINUTE);
    expect(button("Restore this version")).toBeUndefined();
    expect(toasts.shown).toEqual([{ body: "That version is no longer in the history.", type: "info" }]);
  });

  it("keeps the version being viewed open when it is still listed", async () => {
    await mount(listing([7, 6, 5], 9));
    await open(1);
    docs.versions.mockResolvedValue(listing([8, 7, 6], 9));
    await advance(MINUTE);
    expect(button("Restore this version")).toBeDefined();
    expect(toasts.shown).toEqual([]);
  });

  it("compares with the current document once the chosen baseline leaves the listing", async () => {
    contents({ 7: "Seven", 6: "Six", 5: "Five" });
    await mount(listing([7, 6, 5], 7));
    await open(0);
    await compareWith(2); // v5
    expect(dialogText()).not.toContain("in the current document");

    docs.versions.mockResolvedValue(listing([8, 7, 6], 8));
    await advance(MINUTE);
    expect(dialogText()).toContain("in the current document");
    expect(document.body.querySelector('[role="combobox"]')!.textContent).toContain("Current document");
  });

  it("closes the dialog on a 404 from Delete, with one toast", async () => {
    docs.deleteVersion.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    await mount(listing([7, 6], 9));
    await open(1);
    docs.versions.mockResolvedValue(listing([7], 9));
    await act(async () => button("Delete")!.click());
    await act(async () => button("Delete")!.click()); // the in-place confirm
    expect(button("Close")).toBeUndefined();
    expect(toasts.shown).toEqual([{ body: "Delete failed. That version is no longer available.", type: "error" }]);
  });

  it("closes the dialog on a 404 from Restore, with one toast", async () => {
    docs.restoreVersion.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    await mount(listing([7, 6], 9));
    await open(1);
    docs.versions.mockResolvedValue(listing([7], 9));
    await act(async () => button("Restore this version")!.click());
    expect(button("Close")).toBeUndefined();
    expect(toasts.shown).toEqual([{ body: "Restore failed. That version is no longer available.", type: "error" }]);
    expect(rows()).toHaveLength(1);
  });
});

describe("VersionsPanel: refresh", () => {
  it("re-reads the listing once edits have settled, and shows what was recorded meanwhile", async () => {
    await mount(listing([1], 1));
    expect(docs.versions).toHaveBeenCalledTimes(1);

    docs.versions.mockResolvedValue(listing([4, 1], 4));
    ydoc.getText("t").insert(0, "edit");
    await advance(10_000);
    ydoc.getText("t").insert(0, "more ");
    await advance(SETTLED_MS - 1);
    expect(docs.versions).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(docs.versions).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.contains(current()[0]!)).toBe(true);
  });

  it("re-reads every minute while the page is visible, and not while it is hidden", async () => {
    await mount(listing([1], 3));
    // A version owed by the interval, recorded with no further edit.
    docs.versions.mockResolvedValue(listing([4, 1], 4));
    await advance(MINUTE);
    expect(docs.versions).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(2);

    await setVisibility("hidden");
    await advance(3 * MINUTE);
    expect(docs.versions).toHaveBeenCalledTimes(2);
  });

  it("re-reads as soon as the page becomes visible again", async () => {
    await mount(listing([1], 1));
    await setVisibility("hidden");
    expect(docs.versions).toHaveBeenCalledTimes(1);
    await setVisibility("visible");
    expect(docs.versions).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest answer when an older one arrives late", async () => {
    await mount(listing([1], 1));
    const slow = deferred();
    docs.versions.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(listing([5, 4, 1], 5));
    await advance(MINUTE); // slow
    await setVisibility("hidden");
    await setVisibility("visible"); // fast
    expect(rows()).toHaveLength(3);

    await act(async () => slow.resolve(listing([4, 1], 4)));
    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.contains(current()[0]!)).toBe(true);
  });

  it("keeps the list when a re-read fails", async () => {
    await mount(listing([4, 1], 4));
    docs.versions.mockRejectedValue(new Error("offline"));
    await advance(MINUTE);
    expect(rows()).toHaveLength(2);
  });

  it("stops reading once closed", async () => {
    await mount(listing([1], 1));
    await act(async () => root.unmount());
    ydoc.getText("t").insert(0, "edit");
    await advance(SETTLED_MS + 3 * MINUTE);
    await setVisibility("visible");
    expect(docs.versions).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });
});
