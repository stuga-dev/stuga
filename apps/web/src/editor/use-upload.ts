/**
 * The editor's one upload path (toolbar, slash menu, paste, drop). An image of a type the node
 * shows lands as an image; any other file as a link to it, named for the file, which downloads
 * it. No placeholder node is inserted while bytes move: the schema must match the server's, so
 * progress lives in UploadTray and the image or link lands once uploaded.
 */
import { useCallback, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { SAFE_IMAGE_MIMES } from "@stuga/protocol/api/media";
import { Media } from "../api";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";

interface UploadItem {
  id: string;
  name: string;
  /** 0..1 byte progress; reaches 1 just before insertion. */
  progress: number;
  status: "uploading" | "error";
  error?: string;
  cancel: () => void;
}

export interface Uploader {
  items: UploadItem[];
  /** Upload files and insert each, in the order given, once it lands: an image as an image, anything else as a link. */
  upload: (files: File[]) => void;
  /** Dismiss a failed row from the tray. */
  dismiss: (id: string) => void;
}

let seq = 0;
const nextId = () => `up-${Date.now()}-${seq++}`;

/**
 * Where an upload lands: after a selected node (the image just inserted, so a second one adds
 * rather than replaces), after the first block when the caret is in it (that line is the
 * document's title, which a file must not rename), else at the selection.
 */
export function insertionPoint(editor: Editor): number | { from: number; to: number } {
  const { selection, doc } = editor.state;
  if (selection instanceof NodeSelection) return selection.to;
  const first = doc.firstChild;
  const inFirst = selection.$from.depth >= 1 && selection.$from.index(0) === 0;
  if (inFirst && first?.isTextblock && first.textContent.trim() !== "") return first.nodeSize;
  return { from: selection.from, to: selection.to };
}

/** Insert an uploaded file where `insertionPoint` says: an image as an image, anything else as a link named for it. */
function insertUpload(editor: Editor, file: { image: boolean; src: string; name: string; alt: string }): void {
  const content = file.image
    ? { type: "image", attrs: { src: file.src, alt: file.alt } }
    : [{ type: "text", text: file.name, marks: [{ type: "link", attrs: { href: file.src } }] }, { type: "text", text: " " }];
  editor.chain().focus().insertContentAt(insertionPoint(editor), content).run();
}

/** Whether the node shows `file` as an image; any other file is linked to. */
export const isShownImage = (file: File): boolean => (SAFE_IMAGE_MIMES as readonly string[]).includes(file.type.toLowerCase());

export function useUpload(editor: Editor | null, docId: string): Uploader {
  const [items, setItems] = useState<UploadItem[]>([]);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const dismiss = useCallback((id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const upload = useCallback(
    (files: File[]) => {
      // Uploads run side by side but land in the order they were picked: each waits for the one before.
      let landed: Promise<void> = Promise.resolve();
      for (const file of files) {
        const id = nextId();
        const controller = new AbortController();
        const image = isShownImage(file);
        const row: UploadItem = {
          id,
          name: file.name || (image ? t("editor.upload.defaultImageName") : t("editor.upload.defaultFileName")),
          progress: 0,
          status: "uploading",
          cancel: () => controller.abort(),
        };
        setItems((xs) => [...xs, row]);

        const uploaded = Media.uploadWithProgress(
          docId,
          file,
          (frac) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, progress: frac } : x))),
          controller.signal,
        );
        // Handled once its turn comes; this keeps an early failure from reading as unhandled meanwhile.
        uploaded.catch(() => undefined);
        landed = landed
          .then(() => uploaded)
          .then(({ hash, url }) => {
            const ed = editorRef.current;
            if (ed && !ed.isDestroyed) {
              // The same relative path the server writes for agent-inserted images.
              insertUpload(ed, { image, src: image ? `/api/docs/${docId}/media/${hash}` : url, name: row.name, alt: file.name });
            }
            setItems((xs) => xs.filter((x) => x.id !== id));
          })
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") {
              setItems((xs) => xs.filter((x) => x.id !== id));
              return;
            }
            setItems((xs) =>
              xs.map((x) => (x.id === id ? { ...x, status: "error", error: errorMessage(err, t("editor.upload.failed")) } : x)),
            );
          });
      }
    },
    [docId],
  );

  return { items, upload, dismiss };
}

/** The files in a clipboard or drag payload. */
export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  // Some browsers expose files but not items.
  if (out.length === 0) out.push(...Array.from(dt.files ?? []));
  return out;
}

/** The image files in a clipboard or drag payload. */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  return filesFrom(dt).filter((f) => f.type.startsWith("image/"));
}
