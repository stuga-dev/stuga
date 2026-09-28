/**
 * The editor's one upload path (toolbar, slash menu, paste, drop). An image of a type the node
 * shows lands as an image; any other file as a link to it, named for the file, which downloads
 * it. No placeholder node is inserted while bytes move: the schema must match the server's, so
 * progress lives in UploadTray and the image or link lands once uploaded.
 */
import { useCallback, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { SAFE_IMAGE_MIMES } from "@stuga/protocol/api/media";
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

export interface Uploader {
  items: UploadItem[];
  /** Upload files and insert each at the selection once it lands: an image as an image, anything else as a link. */
  upload: (files: File[]) => void;
  /** Dismiss a failed row from the tray. */
  dismiss: (id: string) => void;
}

let seq = 0;
const nextId = () => `up-${Date.now()}-${seq++}`;

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
      for (const file of files) {
        const id = nextId();
        const controller = new AbortController();
        const image = isShownImage(file);
        const row: UploadItem = {
          id,
          name: file.name || (image ? "image" : "file"),
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
          .then(({ hash, url }) => {
            const ed = editorRef.current;
            if (ed && !ed.isDestroyed) {
              const chain = ed.chain().focus();
              // The same relative path the server writes for agent-inserted images.
              if (image) chain.setImage({ src: `/api/docs/${docId}/media/${hash}`, alt: file.name }).run();
              else chain.insertContent([{ type: "text", text: row.name, marks: [{ type: "link", attrs: { href: url } }] }, { type: "text", text: " " }]).run();
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
