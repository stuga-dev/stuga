/**
 * A document's AI co-author conversation. It never writes to the document: a
 * turn's edits go into the run ledger server-side and are reviewed where the
 * text is. The conversation is React state only.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { StugaProvider } from "../sync/stuga-provider";
import type { AiAttachment } from "@stuga/protocol/wire/doc-socket";
import { useSharedEditor } from "../editor/editor-context";
import { Media } from "../api";
import { citedSources } from "./citations";
import type { ChatTurn } from "./ChatTranscript";

/**
 * An image attached to the next turn. It uploads over HTTP as soon as it is
 * attached, never over the document socket, and `path` (set once uploaded) is
 * the only shape the server accepts back as an attachment.
 */
interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  /** A local object URL until the upload lands, then the stored URL. */
  previewUrl: string;
  path?: string;
  /** 0..1 byte progress. */
  progress: number;
  error?: string;
  cancel: () => void;
}

/** A selection-scoped edit being composed: the quoted text and where to float the composer. */
interface SelectionEdit {
  quote: string;
  rect: { top: number; left: number };
}

interface AiCoauthorCtx {
  turns: ChatTurn[];
  streaming: boolean;
  /** A model id from GET /api/models, or "auto". */
  model: string;
  setModel: (m: string) => void;
  /** A Collection (or ALL_DOCUMENTS_SCOPE) the turn may search and cite; null = this document only. */
  collectionId: string | null;
  setCollectionId: (id: string | null) => void;
  /** Send a chat turn, scoped to the editor's live selection if there is one. */
  send: (prompt: string) => void;
  /** Ask the server to end the turn; `streaming` clears on its receipt, which still reports what was proposed. */
  stop: () => void;
  attachments: PendingAttachment[];
  attachImages: (files: File[]) => void;
  /** Drop one staged image, aborting it if still uploading. */
  removeAttachment: (id: string) => void;
  /** Clear the transcript. Proposals are server state and stay in the run bar. */
  newChat: () => void;
  selectionEdit: SelectionEdit | null;
  /** Capture the current selection as the target of an "Edit with AI" instruction. */
  startSelectionEdit: () => void;
  /** Send the captured selection with an instruction, revealing the panel. */
  submitSelectionEdit: (instruction: string) => void;
  cancelSelectionEdit: () => void;
}

const Ctx = createContext<AiCoauthorCtx | null>(null);

export function AiCoauthorProvider({
  provider,
  docId,
  onRequestOpen,
  children,
}: {
  provider: StugaProvider | null;
  /** The document attachments are uploaded to. */
  docId: string;
  /** Reveals the AI panel when a selection edit is submitted. */
  onRequestOpen: () => void;
  children: ReactNode;
}) {
  const { editor } = useSharedEditor();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState("auto");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [selectionEdit, setSelectionEdit] = useState<SelectionEdit | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  // Captured on "Edit with AI", so focus moving into the composer can't change the target.
  const selEditTarget = useRef<string | null>(null);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((xs) => {
      const hit = xs.find((x) => x.id === id);
      hit?.cancel();
      // Only an un-uploaded preview is an object URL.
      if (hit && !hit.path) URL.revokeObjectURL(hit.previewUrl);
      return xs.filter((x) => x.id !== id);
    });
  }, []);

  const attachImages = useCallback(
    (files: File[]) => {
      for (const file of files.filter((f) => f.type.startsWith("image/"))) {
        const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        setAttachments((xs) => [
          ...xs,
          {
            id,
            name: file.name || "image",
            mime: file.type,
            previewUrl: URL.createObjectURL(file),
            progress: 0,
            cancel: () => controller.abort(),
          },
        ]);
        Media.uploadWithProgress(
          docId,
          file,
          (frac) => setAttachments((xs) => xs.map((x) => (x.id === id ? { ...x, progress: frac } : x))),
          controller.signal,
        )
          .then(({ url, hash }) => {
            setAttachments((xs) =>
              xs.map((x) => {
                if (x.id !== id) return x;
                // The transcript echoes the thumbnail after the attachment is
                // cleared, so it must point at the stored image, not a blob: URL.
                URL.revokeObjectURL(x.previewUrl);
                return { ...x, progress: 1, previewUrl: url, path: `/api/docs/${docId}/media/${hash}` };
              }),
            );
          })
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") {
              setAttachments((xs) => xs.filter((x) => x.id !== id));
              return;
            }
            setAttachments((xs) =>
              xs.map((x) => (x.id === id ? { ...x, error: (err as Error).message } : x)),
            );
          });
      }
    },
    [docId],
  );

  const runTurn = useCallback(
    async (prompt: string, selectedText: string | null) => {
      if (!provider || !editor) return;
      const history = turns.map((t) => ({ role: t.role, content: t.text }));
      // Only uploaded attachments have a media path the model can reference.
      const ready = attachments.filter((a) => a.path && !a.error);
      const quote = selectedText?.trim() || undefined;
      setTurns((t) => [
        ...t,
        {
          role: "user",
          text: prompt,
          quote,
          images: ready.length ? ready.map((a) => ({ url: a.previewUrl, name: a.name })) : undefined,
        },
        { role: "assistant", text: "", status: "Thinking…" },
      ]);
      setStreaming(true);
      // Cleared at send, not on the reply, so a second message can't re-send them.
      setAttachments([]);
      provider.sendAiRequest(
        {
          prompt,
          selected_text: selectedText,
          model,
          history,
          collection_id: collectionId,
          attachments: ready.map(
            (a): AiAttachment => ({ url: a.path!, name: a.name, mime: a.mime }),
          ),
        },
        {
          onChunk: (chunk) =>
            setTurns((t) => {
              const copy = [...t];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, text: last.text + chunk, status: undefined };
              return copy;
            }),
          onStatus: (status) =>
            setTurns((t) => {
              const copy = [...t];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant" && !last.text) copy[copy.length - 1] = { ...last, status };
              return copy;
            }),
          onDone: () => {
            setStreaming(false);
            setTurns((t) => {
              const last = t[t.length - 1];
              if (!last || last.role !== "assistant" || !last.status) return t;
              const copy = [...t];
              copy[copy.length - 1] = { ...last, status: undefined };
              return copy;
            });
          },
          onEdits: (payload) => {
            // The receipt: the edits already reached the run ledger over the socket.
            setTurns((t) => {
              const copy = [...t];
              const last = copy[copy.length - 1];
              if (!last || last.role !== "assistant") return t;
              const next: ChatTurn = { ...last };
              if (payload.citations?.length) {
                next.sources = citedSources(payload.citations);
                next.citations = payload.citations;
              }
              if (payload.staged > 0) next.staged = payload.staged;
              if (payload.cross_docs?.length) next.crossDocs = payload.cross_docs;
              if (payload.error) next.proposeError = payload.error;
              if (payload.notice) next.notice = payload.notice;
              copy[copy.length - 1] = next;
              return copy;
            });
          },
        },
      );
    },
    [provider, editor, turns, model, collectionId, attachments],
  );

  const send = useCallback(
    (prompt: string) => {
      const text = prompt.trim();
      if (!text || streaming || !editor) return;
      const sel = !editor.state.selection.empty ? editor.state.selection : null;
      const selectedText = sel ? editor.state.doc.textBetween(sel.from, sel.to, "\n") : null;
      runTurn(text, selectedText);
    },
    [streaming, editor, runTurn],
  );

  // Clearing `streaming` here would race the receipt that reports what the stopped turn proposed.
  const stop = useCallback(() => {
    if (!streaming || !provider) return;
    provider.cancelAiRequest();
    setTurns((t) => {
      const last = t[t.length - 1];
      if (!last || last.role !== "assistant" || last.text) return t;
      const copy = [...t];
      copy[copy.length - 1] = { ...last, status: "Stopping…" };
      return copy;
    });
  }, [streaming, provider]);

  const newChat = useCallback(() => {
    if (streaming) return;
    setTurns([]);
  }, [streaming]);

  const startSelectionEdit = useCallback(() => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const selectedText = editor.state.doc.textBetween(from, to, "\n");
    if (!selectedText.trim()) return;
    const coords = editor.view.coordsAtPos(to);
    selEditTarget.current = selectedText;
    setSelectionEdit({ quote: selectedText, rect: { top: coords.bottom, left: coords.left } });
  }, [editor]);

  const submitSelectionEdit = useCallback(
    (instruction: string) => {
      const text = instruction.trim();
      const target = selEditTarget.current;
      if (!text || !target || streaming) return;
      setSelectionEdit(null);
      onRequestOpen();
      runTurn(text, target);
    },
    [streaming, onRequestOpen, runTurn],
  );

  const cancelSelectionEdit = useCallback(() => setSelectionEdit(null), []);

  const value: AiCoauthorCtx = {
    turns,
    streaming,
    model,
    setModel,
    collectionId,
    setCollectionId,
    send,
    stop,
    attachments,
    attachImages,
    removeAttachment,
    newChat,
    selectionEdit,
    startSelectionEdit,
    submitSelectionEdit,
    cancelSelectionEdit,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAiCoauthor(): AiCoauthorCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAiCoauthor must be used within an AiCoauthorProvider");
  return ctx;
}
