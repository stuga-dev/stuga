/**
 * A document's AI co-author conversation. It never writes to the document: a
 * turn's edits go into the run ledger server-side and are reviewed where the
 * text is. The conversation lives in this tab's memory only, kept per account
 * and document so leaving the document and coming back finds it again.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { StugaProvider } from "../sync/stuga-provider";
import type { AiAttachment, RevisionScope } from "@stuga/protocol/wire/doc-socket";
import { useSharedEditor } from "../editor/editor-context";
import { useAiChat } from "../state/model-options";
import { Media } from "../api";
import { citedSources } from "./citations";
import { coauthorActivityText, coauthorErrorText, coauthorNoticesText } from "./turn-text";
import { t } from "../i18n/i18n";
import { errorMessage, getAlias } from "../lib/http/client";
import type { ChatTurn } from "./ChatTranscript";

/** Conversations by account and document, most recent last; never written anywhere. */
const keptChats = new Map<string, ChatTurn[]>();
const KEPT_CHATS_MAX = 20;

function chatKey(docId: string): string {
  return `${getAlias() ?? ""}\u0000${docId}`;
}

/** A reply cut off by leaving the page says so when the conversation reopens, rather than "Thinking…" forever. */
function interrupted(turns: ChatTurn[]): ChatTurn[] {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return turns;
  return [...turns.slice(0, -1), { ...last, status: undefined, notice: t("ai.transcript.interrupted") }];
}

function keepChat(docId: string, turns: ChatTurn[]): void {
  const key = chatKey(docId);
  keptChats.delete(key);
  if (turns.length === 0) return;
  keptChats.set(key, turns);
  if (keptChats.size > KEPT_CHATS_MAX) keptChats.delete(keptChats.keys().next().value!);
}

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

/** A Reject and revise waiting for the turn in flight to end. */
interface QueuedRevision {
  note: string;
  runId: string;
  feedbackId: string;
}

/** The turn that answers queued rejections: one turn for all of them, each note under its own change server-side. */
function revisionPrompt(list: QueuedRevision[]): string {
  // i18n-exempt: a prompt sent to the model
  return list.length === 1
    ? `Revise the edits I rejected, as my note says, and change nothing else: ${list[0]!.note}`
    : `Revise the edits I rejected, as my notes say, and change nothing else:\n${list.map((r) => `- ${r.note}`).join("\n")}`;
}

/** What the transcript shows for that turn: the person's own notes, introduced in their language. */
function revisionShown(list: QueuedRevision[]): string {
  const notes = list.length === 1 ? list[0]!.note : list.map((r) => `- ${r.note}`).join("\n");
  return t("ai.coauthor.revisionShown", { count: list.length, notes });
}

/** A turn's options. `shown` is what the transcript shows for an English prompt the person never typed. */
interface TurnOptions {
  shown?: string;
  revise?: RevisionScope[];
}

/** A selection-scoped edit being composed: the quoted text and where to float the composer. */
interface SelectionEdit {
  quote: string;
  rect: { top: number; left: number };
}

interface AiCoauthorCtx {
  /** The node's AI chat is on, so the co-author can take a turn. */
  available: boolean;
  turns: ChatTurn[];
  streaming: boolean;
  /** A model id from GET /api/models, or "auto". */
  model: string;
  setModel: (m: string) => void;
  /** A Collection (or ALL_DOCUMENTS_SCOPE) the turn may search and cite; null = this document only. */
  collectionId: string | null;
  setCollectionId: (id: string | null) => void;
  /**
   * Send a chat turn, scoped to the editor's live selection if there is one. `shown` replaces
   * `prompt` in the transcript when the prompt is English written for the model.
   */
  send: (prompt: string, shown?: string) => void;
  /** Ask the server to end the turn; `streaming` clears on its receipt, which still reports what was proposed. */
  stop: () => void;
  /**
   * Revise after the user rejected the co-author's edits with `note`: a turn asks for that
   * revision, and the server lets it change only the passages that rejection (`scope`) covered.
   * While a turn is running it waits, and every revision queued meanwhile goes in one turn when it ends.
   */
  revise: (note: string, scope: { runId: string; feedbackId: string }) => void;
  /** Revisions waiting for the turn in flight to end. */
  queuedRevisions: number;
  /** The turn they waited for was stopped or failed, so they wait for Revise now instead. */
  revisionPaused: boolean;
  reviseNow: () => void;
  /** Drop the queued revisions; the rejections and their notes stand. */
  cancelRevisions: () => void;
  attachments: PendingAttachment[];
  attachImages: (files: File[]) => void;
  /** Drop one staged image, aborting it if still uploading. */
  removeAttachment: (id: string) => void;
  /** Clear the transcript. Proposals are server state and stay in the run bar. */
  newChat: () => void;
  selectionEdit: SelectionEdit | null;
  /** Capture the current selection as the target of an "Edit with AI" instruction. */
  startSelectionEdit: () => void;
  /** Send the captured selection with an instruction, revealing the panel; `shown` as for `send`. */
  submitSelectionEdit: (instruction: string, shown?: string) => void;
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
  const available = useAiChat() === "on";
  const [turns, setTurns] = useState<ChatTurn[]>(() => keptChats.get(chatKey(docId)) ?? []);
  useEffect(() => keepChat(docId, turns), [docId, turns]);
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState("auto");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [selectionEdit, setSelectionEdit] = useState<SelectionEdit | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  // Captured on "Edit with AI", so focus moving into the composer can't change the target.
  const selEditTarget = useRef<string | null>(null);

  const [queued, setQueued] = useState<QueuedRevision[]>([]);
  const [revisionPaused, setRevisionPaused] = useState(false);
  // Read when a turn's receipt arrives, outside any render, so they are kept in step by hand.
  const queuedRef = useRef<QueuedRevision[]>([]);
  const pausedRef = useRef(false);
  /** From send until the turn's receipt: `streaming` clears at "done", before the receipt arrives. */
  const turnOpen = useRef(false);
  const stopped = useRef(false);
  /** Whether the last turn to end was stopped or failed. */
  const halted = useRef(false);
  const [receipts, setReceipts] = useState(0);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  useEffect(
    () => () => {
      if (turnOpen.current) keepChat(docId, interrupted(turnsRef.current));
    },
    [docId],
  );
  const setQueue = (next: QueuedRevision[], paused = false) => {
    queuedRef.current = next;
    pausedRef.current = paused;
    setQueued(next);
    setRevisionPaused(paused);
  };

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
            name: file.name || "image", // i18n-exempt: a file name sent to the model
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
              xs.map((x) => (x.id === id ? { ...x, error: errorMessage(err, t("ai.panel.uploadFailed")) } : x)),
            );
          });
      }
    },
    [docId],
  );

  const runTurn = useCallback(
    async (prompt: string, selectedText: string | null, opts: TurnOptions = {}) => {
      if (!provider || !editor) return;
      const history = turns.map((turn) => ({ role: turn.role, content: turn.text }));
      // Only uploaded attachments have a media path the model can reference. A revision is the
      // reviewer's note, not their next message, so images staged for that message stay staged.
      const ready = opts.revise ? [] : attachments.filter((a) => a.path && !a.error);
      const quote = selectedText?.trim() || undefined;
      setTurns((ts) => [
        ...ts,
        {
          role: "user",
          text: prompt,
          shown: opts.shown,
          quote,
          images: ready.length ? ready.map((a) => ({ url: a.previewUrl, name: a.name })) : undefined,
          ...(opts.revise ? { revises: opts.revise.map((r) => r.feedback_id) } : {}),
        },
        { role: "assistant", text: "", status: t("ai.status.thinking") },
      ]);
      setStreaming(true);
      turnOpen.current = true;
      stopped.current = false;
      // Cleared at send, not on the reply, so a second message can't re-send them.
      if (!opts.revise) setAttachments([]);
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
          ...(opts.revise ? { revise: opts.revise } : {}),
        },
        {
          onChunk: (chunk) =>
            setTurns((ts) => {
              const copy = [...ts];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, text: last.text + chunk, status: undefined };
              return copy;
            }),
          onStatus: (activity) =>
            setTurns((ts) => {
              const copy = [...ts];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant" && !last.text) copy[copy.length - 1] = { ...last, status: coauthorActivityText(activity) };
              return copy;
            }),
          onDone: () => {
            setStreaming(false);
            setTurns((ts) => {
              const last = ts[ts.length - 1];
              if (!last || last.role !== "assistant" || !last.status) return ts;
              const copy = [...ts];
              copy[copy.length - 1] = { ...last, status: undefined };
              return copy;
            });
          },
          onEdits: (payload) => {
            // The receipt: the edits already reached the run ledger over the socket.
            setTurns((ts) => {
              const copy = [...ts];
              const last = copy[copy.length - 1];
              if (!last || last.role !== "assistant") return ts;
              const next: ChatTurn = { ...last };
              if (payload.citations?.length) {
                next.sources = citedSources(payload.citations);
                next.citations = payload.citations;
              }
              if (payload.staged > 0) next.staged = payload.staged;
              if (payload.applied > 0) next.applied = payload.applied;
              if (payload.run_id && payload.hunk_ids?.length) {
                next.runId = payload.run_id;
                next.hunkIds = payload.hunk_ids;
              }
              if (payload.cross_docs?.length) next.crossDocs = payload.cross_docs;
              if (payload.error) next.proposeError = coauthorErrorText(payload.error);
              const notice = coauthorNoticesText(payload.notices);
              if (notice) next.notice = notice;
              copy[copy.length - 1] = next;
              return copy;
            });
            turnOpen.current = false;
            halted.current = stopped.current || payload.error !== null;
            // Settled after the render that shows this turn, so a revision's history includes it.
            setReceipts((n) => n + 1);
          },
        },
      );
    },
    [provider, editor, turns, model, collectionId, attachments],
  );

  const send = useCallback(
    (prompt: string, shown?: string) => {
      const text = prompt.trim();
      if (!text || streaming || !editor) return;
      const sel = !editor.state.selection.empty ? editor.state.selection : null;
      const selectedText = sel ? editor.state.doc.textBetween(sel.from, sel.to, "\n") : null;
      runTurn(text, selectedText, { shown });
    },
    [streaming, editor, runTurn],
  );

  const startRevisions = (list: QueuedRevision[]) => {
    setQueue([]);
    const scopes: RevisionScope[] = list.map((r) => ({ run_id: r.runId, feedback_id: r.feedbackId }));
    void runTurn(revisionPrompt(list), null, { shown: revisionShown(list), revise: scopes });
  };
  /**
   * A turn's receipt arrived. Its queued revisions run now, in one turn, unless the user stopped it
   * or it failed: then they wait for Revise now, since starting more work after a Stop is not asked for.
   */
  const afterTurn = useRef((_halted: boolean) => {});
  afterTurn.current = (wasHalted: boolean) => {
    const list = queuedRef.current;
    if (list.length === 0 || pausedRef.current || turnOpen.current) return;
    if (wasHalted) setQueue(list, true);
    else startRevisions(list);
  };

  useEffect(() => {
    if (receipts > 0) afterTurn.current(halted.current);
  }, [receipts]);

  const revise = useCallback(
    (note: string, scope: { runId: string; feedbackId: string }) => {
      const text = note.trim();
      if (!text || !editor) return;
      onRequestOpen();
      const item = { note: text, ...scope };
      if (turnOpen.current || pausedRef.current) setQueue([...queuedRef.current, item], pausedRef.current);
      else startRevisions([item]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, onRequestOpen, runTurn],
  );

  const reviseNow = useCallback(() => {
    const list = queuedRef.current;
    if (list.length === 0 || turnOpen.current) return;
    startRevisions(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runTurn]);

  const cancelRevisions = useCallback(() => setQueue([]), []);

  // Clearing `streaming` here would race the receipt that reports what the stopped turn proposed.
  const stop = useCallback(() => {
    if (!streaming || !provider) return;
    stopped.current = true;
    provider.cancelAiRequest();
    setTurns((ts) => {
      const last = ts[ts.length - 1];
      if (!last || last.role !== "assistant" || last.text) return ts;
      const copy = [...ts];
      copy[copy.length - 1] = { ...last, status: t("ai.status.stopping") };
      return copy;
    });
  }, [streaming, provider]);

  const newChat = useCallback(() => {
    if (streaming) return;
    // A new chat starts clean; the rejections and their notes stand.
    setQueue([]);
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
    (instruction: string, shown?: string) => {
      const text = instruction.trim();
      const target = selEditTarget.current;
      if (!text || !target || streaming) return;
      setSelectionEdit(null);
      onRequestOpen();
      runTurn(text, target, { shown });
    },
    [streaming, onRequestOpen, runTurn],
  );

  const cancelSelectionEdit = useCallback(() => setSelectionEdit(null), []);

  const value: AiCoauthorCtx = {
    available,
    turns,
    streaming,
    model,
    setModel,
    collectionId,
    setCollectionId,
    send,
    stop,
    revise,
    queuedRevisions: queued.length,
    revisionPaused,
    reviseNow,
    cancelRevisions,
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

/** The co-author, where the page has one: the review surfaces render with and without it. */
export function useOptionalAiCoauthor(): AiCoauthorCtx | null {
  return useContext(Ctx);
}

export function useAiCoauthor(): AiCoauthorCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAiCoauthor must be used within an AiCoauthorProvider");
  return ctx;
}
