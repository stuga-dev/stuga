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

  it("takes every file from a drop or paste, and the chat only its images", () => {
    const pdf = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    const png = new File(["x"], "b.png", { type: "image/png" });
    const dt = { items: [pdf, png].map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), files: [] } as unknown as DataTransfer;
    expect(filesFrom(dt)).toEqual([pdf, png]);
    expect(imageFilesFrom(dt)).toEqual([png]);
  });
});
