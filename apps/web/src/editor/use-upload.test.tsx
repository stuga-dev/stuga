// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor } from "@tiptap/react";
import { docToMarkdown } from "@stuga/crdt-ops";
import { stugaEditorExtensions } from "./extensions";

const uploadWithProgress = vi.hoisted(() => vi.fn());
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Media: { uploadWithProgress } }));

const { filesFrom, imageFilesFrom, useUpload } = await import("./use-upload");
type Uploader = ReturnType<typeof useUpload>;

const HASH = "a".repeat(64);
// jsdom lays nothing out; an insert scrolls the selection into view, which measures a range.
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function mount(): { editor: Editor; uploader: () => Uploader } {
  const ydoc = new Y.Doc();
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: stugaEditorExtensions({ ydoc, awareness: new Awareness(ydoc), alias: "tester", onClickComment: () => {} }) });
  let current!: Uploader;
  function Probe() {
    current = useUpload(editor, "d1");
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  cleanup.push(() => {
    act(() => root.unmount());
    editor.destroy();
  });
  return { editor, uploader: () => current };
}

describe("uploading into a document", () => {
  it("inserts an image the node shows as an image, and any other file as a link named for it", async () => {
    uploadWithProgress.mockImplementation(async (_doc: string, file: File) => ({
      hash: HASH,
      url: file.type === "image/png" ? `/api/docs/d1/media/${HASH}` : `/api/docs/d1/media/${HASH}/${encodeURIComponent(file.name)}`,
    }));
    const { editor, uploader } = mount();
    await act(async () => uploader().upload([new File(["%PDF"], "Q3 brief.pdf", { type: "application/pdf" })]));
    await act(async () => uploader().upload([new File(["x"], "shot.png", { type: "image/png" })]));
    const markdown = docToMarkdown(editor.state.doc);
    expect(markdown).toContain(`[Q3 brief.pdf](/api/docs/d1/media/${HASH}/Q3%20brief.pdf)`);
    expect(markdown).toContain(`![shot.png](/api/docs/d1/media/${HASH})`);
    expect(uploader().items).toEqual([]);
  });

  it("adds a second image after the first, which is still selected, instead of replacing it", async () => {
    uploadWithProgress.mockImplementation(async () => ({ hash: HASH, url: `/api/docs/d1/media/${HASH}` }));
    const { editor, uploader } = mount();
    act(() => editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Notes" }] }, { type: "paragraph", content: [{ type: "text", text: "Body" }] }] }));
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
    await act(async () => uploader().upload([new File(["x"], "one.png", { type: "image/png" })]));
    await act(async () => uploader().upload([new File(["x"], "two.png", { type: "image/png" })]));
    const markdown = docToMarkdown(editor.state.doc);
    expect(markdown.indexOf("![one.png]")).toBeGreaterThan(-1);
    expect(markdown.indexOf("![two.png]")).toBeGreaterThan(markdown.indexOf("![one.png]"));
  });

  it("lands several files in the order they were picked, whichever finishes first", async () => {
    const done: Record<string, (v: { hash: string; url: string }) => void> = {};
    uploadWithProgress.mockImplementation(
      (_doc: string, file: File) => new Promise((resolve) => (done[file.name] = resolve)),
    );
    const { editor, uploader } = mount();
    act(() => editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Notes" }] }, { type: "paragraph" }] }));
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
    act(() => uploader().upload(["a.pdf", "b.pdf", "c.pdf"].map((n) => new File(["%PDF"], n, { type: "application/pdf" }))));
    await act(async () => done["c.pdf"]!({ hash: HASH, url: "/f/c.pdf" }));
    await act(async () => done["b.pdf"]!({ hash: HASH, url: "/f/b.pdf" }));
    expect(docToMarkdown(editor.state.doc)).not.toContain("b.pdf");
    await act(async () => done["a.pdf"]!({ hash: HASH, url: "/f/a.pdf" }));
    expect(docToMarkdown(editor.state.doc)).toMatch(/^Notes\n\n\[a\.pdf\]\(\/f\/a\.pdf\) \[b\.pdf\]\(\/f\/b\.pdf\) \[c\.pdf\]\(\/f\/c\.pdf\)/);
  });

  it("puts files picked with the caret in the title below it, so the title stays", async () => {
    uploadWithProgress.mockImplementation(async (_doc: string, file: File) => ({ hash: HASH, url: `/f/${file.name}` }));
    const { editor, uploader } = mount();
    act(() => editor.commands.setContent({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Notes with files" }] }, { type: "paragraph", content: [{ type: "text", text: "Body" }] }] }));
    act(() => editor.commands.setTextSelection(1));
    await act(async () => uploader().upload([new File(["%PDF"], "menu.pdf", { type: "application/pdf" }), new File(["x"], "shot.png", { type: "image/png" })]));
    const doc = editor.state.doc;
    expect(doc.firstChild!.textContent).toBe("Notes with files");
    expect(doc.child(1).textContent.trim()).toBe("menu.pdf");
    expect(doc.child(2).type.name).toBe("image");
  });

  it("takes every file from a drop or paste, and the chat only its images", () => {
    const pdf = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    const png = new File(["x"], "b.png", { type: "image/png" });
    const dt = { items: [pdf, png].map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), files: [] } as unknown as DataTransfer;
    expect(filesFrom(dt)).toEqual([pdf, png]);
    expect(imageFilesFrom(dt)).toEqual([png]);
  });
});
