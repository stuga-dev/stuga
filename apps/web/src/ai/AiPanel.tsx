/**
 * The document's AI co-author chat. A turn's edits land in the document's run
 * ledger server-side, so they are decided on the ghost diff or the run bar;
 * this panel only reports what each turn proposed.
 */
import { useRef, useState } from "react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { FileText, ImagePlus, SquarePen, X } from "lucide-react";
import { ALL_DOCUMENTS_SCOPE } from "@stuga/protocol/wire/doc-socket";
import { useAiCoauthor } from "./ai-coauthor-context";
import { useSharedEditor } from "../editor/editor-context";
import { useEditorTick } from "../editor/use-editor-tick";
import { AiScopePicker } from "./AiScopePicker";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript } from "./ChatTranscript";

/** Sent when the user attaches an image without typing anything. */
const IMAGE_ONLY_PROMPT = "Insert the attached image at a suitable place in this document.";

/** The dock strip's action for this panel. An empty thread has nothing to start over from. */
export function AiNewChatButton() {
  const { turns, streaming, newChat } = useAiCoauthor();
  if (turns.length === 0) return null;
  return (
    <IconButton
      label="New chat"
      tooltip="New chat"
      variant="ghost"
      size="sm"
      icon={<SquarePen size={16} />}
      onClick={newChat}
      isDisabled={streaming}
    />
  );
}

export function AiPanel() {
  const { turns, streaming, model, setModel, collectionId, setCollectionId, send, stop, attachments, attachImages, removeAttachment } =
    useAiCoauthor();
  const [input, setInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // Send waits for uploads: a turn that dropped a just-attached image looks like the AI ignored it.
  const uploading = attachments.some((a) => !a.path && !a.error);
  const ready = attachments.some((a) => a.path && !a.error);

  const { editor } = useSharedEditor();
  useEditorTick(editor);
  const selectedText =
    editor && !editor.state.selection.empty
      ? editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n").trim()
      : "";

  function onSend() {
    const prompt = input.trim();
    if (streaming || uploading || (!prompt && !ready)) return;
    setInput("");
    send(prompt || IMAGE_ONLY_PROMPT);
  }

  const placeholder =
    collectionId === null
      ? "Ask the AI co-author…"
      : collectionId === ALL_DOCUMENTS_SCOPE
        ? "Ask or instruct using every document in this workspace…"
        : "Ask or instruct using the collection…";

  return (
    <aside className="ai-panel">
      <ChatTranscript
        turns={turns}
        streaming={streaming}
        reviewWhere="in the document"
        empty={
          <>
            Ask for changes to this document — “tighten the opening paragraph”, “add a summary at the top”, “turn the
            notes at the end into a table”. Every edit appears in the document as a suggestion you accept or reject
            there. This chat is private: only edits you accept reach version history.
          </>
        }
      />
      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={onSend}
        onStop={stop}
        streaming={streaming}
        placeholder={placeholder}
        sendLabel={uploading ? "Uploading…" : "Send"}
        canSend={!uploading && (input.trim() !== "" || ready)}
        onImages={attachImages}
        header={
          <>
            {selectedText && (
              <div className="ai-input-quote" title={selectedText}>
                <span className="ai-input-quote__label">Selected</span>
                <span className="ai-input-quote__text">{selectedText}</span>
              </div>
            )}
            <AiScopePicker
              model={model}
              onModelChange={setModel}
              scope={collectionId}
              onScopeChange={setCollectionId}
              base={{ label: "This document only", icon: <FileText size={15} /> }}
            />
            {attachments.length > 0 && (
              <div className="ai-attachments">
                {attachments.map((a) => (
                  <div key={a.id} className={`ai-attachment${a.error ? " ai-attachment--error" : ""}`} title={a.error ?? a.name}>
                    <img className="ai-attachment__thumb" src={a.previewUrl} alt={a.name} />
                    {!a.path && !a.error && (
                      <span className="ai-attachment__progress" style={{ ["--p" as string]: `${Math.round(a.progress * 100)}%` }} />
                    )}
                    <button type="button" className="ai-attachment__remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        }
        tools={
          <>
            <IconButton
              label="Attach image"
              tooltip="Attach an image (or paste / drop one here)"
              variant="ghost"
              size="sm"
              icon={<ImagePlus size={16} />}
              onClick={() => fileRef.current?.click()}
              isDisabled={streaming}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) attachImages(files);
              }}
            />
          </>
        }
      />
    </aside>
  );
}
