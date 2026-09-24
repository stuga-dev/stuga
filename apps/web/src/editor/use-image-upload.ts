/**
 * The editor's one image-upload path (toolbar, slash menu, paste, drop). No
 * placeholder node is inserted while bytes move: the schema must match the
 * server's, so progress lives in UploadTray and the image lands once uploaded.
 */
import { useCallback, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Media } from "../api";

interface UploadItem {
  id: string;
  name: string;
  /** 0..1 byte progress; reaches 1 just before insertion. */
  progress: number;
  status: "uploading" | "error";
  error?: string;
  cancel: () => void;
}

export interface ImageUploader {
  items: UploadItem[];
  /** Upload image files and insert each at the selection once it lands; non-images are skipped. */
  upload: (files: File[]) => void;
  /** Dismiss a failed row from the tray. */
  dismiss: (id: string) => void;
}

let seq = 0;
const nextId = () => `up-${Date.now()}-${seq++}`;

export function useImageUpload(editor: Editor | null, docId: string): ImageUploader {
  const [items, setItems] = useState<UploadItem[]>([]);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const dismiss = useCallback((id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const upload = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      for (const file of images) {
        const id = nextId();
        const controller = new AbortController();
        const row: UploadItem = {
          id,
          name: file.name || "image",
          progress: 0,
          status: "uploading",
          cancel: () => controller.abort(),
        };
        setItems((xs) => [...xs, row]);

        Media.uploadWithProgress(
          docId,
          file,
          (frac) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, progress: frac } : x))),
          controller.signal,
        )
          .then(({ hash }) => {
            const ed = editorRef.current;
            if (ed && !ed.isDestroyed) {
              // The same relative path the server writes for agent-inserted images.
              ed.chain().focus().setImage({ src: `/api/docs/${docId}/media/${hash}`, alt: file.name }).run();
            }
            setItems((xs) => xs.filter((x) => x.id !== id));
          })
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") {
              setItems((xs) => xs.filter((x) => x.id !== id));
              return;
            }
            setItems((xs) =>
              xs.map((x) => (x.id === id ? { ...x, status: "error", error: (err as Error).message } : x)),
            );
          });
      }
    },
    [docId],
  );

  return { items, upload, dismiss };
}

/** Image files in a clipboard or drag payload. */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  // Some browsers expose files but not items.
  if (out.length === 0) {
    for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith("image/")) out.push(f);
  }
  return out;
}
