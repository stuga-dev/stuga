/**
 * The document's AI co-author chat. A turn's edits land in the document's run
 * ledger server-side, so they are decided on the ghost diff or the run bar, or
 * applied at once on a document set that way; this panel only reports what
 * each turn did.
 */
import { useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { FileText, ImagePlus, SquarePen, X } from "lucide-react";
import { ALL_DOCUMENTS_SCOPE } from "@stuga/protocol/wire/doc-socket";
import { useAiCoauthor } from "./ai-coauthor-context";
import { useAgentRuns } from "../review/agent-runs-context";
import { useSharedEditor } from "../editor/editor-context";
import { useEditorTick } from "../editor/use-editor-tick";
import { AiScopePicker } from "./AiScopePicker";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript } from "./ChatTranscript";
import { t, type MessageKey } from "../i18n/i18n";
import { useAiChat } from "../state/model-options";

/** Sent when the user attaches an image without typing anything. */
// i18n-exempt: a prompt sent to the model
const IMAGE_ONLY_PROMPT = "Insert the attached image at a suitable place in this document.";

/** The dock strip's action for this panel. An empty thread has nothing to start over from. */
export function AiNewChatButton() {
  const { turns, streaming, newChat } = useAiCoauthor();
  if (turns.length === 0) return null;
  return (
    <IconButton
      label={t("ai.panel.newChat")}
      tooltip={t("ai.panel.newChat")}
      variant="ghost"
      size="sm"
      icon={<SquarePen size={16} />}
      onClick={newChat}
      isDisabled={streaming}
    />
  );
}

/** What an empty chat offers to ask. */
const EXAMPLES = ["ai.panel.exampleOutline", "ai.panel.exampleSummary", "ai.panel.exampleTable"] as const satisfies readonly MessageKey[];

export function AiPanel({ agentAuto }: { agentAuto: boolean }) {
  const {
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
    queuedRevisions,
    revisionPaused,
    reviseNow,
    cancelRevisions,
  } = useAiCoauthor();
  const { runs } = useAgentRuns();
  const [input, setInput] = useState("");
  const aiChat = useAiChat();
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
    // An image-only turn shows just the image, not the English prompt it is sent with.
    if (prompt) send(prompt);
    else send(IMAGE_ONLY_PROMPT, "");
  }

  const placeholder =
    collectionId === null
      ? t("ai.panel.placeholderDocument")
      : collectionId === ALL_DOCUMENTS_SCOPE
        ? t("ai.panel.placeholderAllDocuments")
        : t("ai.panel.placeholderCollection");

  return (
    <aside className="ai-panel">
      <ChatTranscript
        turns={turns}
        streaming={streaming}
        reviewIn="document"
        runs={runs}
        empty={
          <span className="ai-empty">
            <span className="ai-empty__lead">{t("ai.panel.emptyLead")}</span>
            {/* A tap fills the box, to send as is or change first; with AI off there is no box. */}
            {aiChat !== "off" && (
              <span className="ai-empty__examples">
                {EXAMPLES.map((key) => (
                  <button key={key} type="button" className="ai-empty__example" onClick={() => setInput(t(key))}>
                    {t(key)}
                  </button>
                ))}
              </span>
            )}
            <span className="ai-empty__note">{agentAuto ? t("ai.panel.emptyAuto") : t("ai.panel.emptyReview")}</span>
          </span>
        }
      />
      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={onSend}
        onStop={stop}
        streaming={streaming}
        placeholder={placeholder}
        sendLabel={uploading ? t("ai.panel.uploading") : t("ai.composer.send")}
        canSend={!uploading && (input.trim() !== "" || ready)}
        onImages={attachImages}
        header={
          <>
            {queuedRevisions > 0 && (
              <div className="ai-revision-queue" role="status">
                <span className="ai-revision-queue__text">
                  {revisionPaused
                    ? t("ai.panel.revisionPaused", { count: queuedRevisions })
                    : t("ai.panel.revisionQueued", { count: queuedRevisions })}
                </span>
                {revisionPaused && <Button label={t("ai.panel.reviseNow")} variant="secondary" size="sm" onClick={reviseNow} isDisabled={streaming} />}
                <Button label={t("common.cancel")} variant="ghost" size="sm" onClick={cancelRevisions} />
              </div>
            )}
            {selectedText && (
              <div className="ai-input-quote" title={selectedText}>
                <span className="ai-input-quote__label">{t("ai.panel.selected")}</span>
                <span className="ai-input-quote__text">{selectedText}</span>
              </div>
            )}
            <AiScopePicker
              model={model}
              onModelChange={setModel}
              scope={collectionId}
              onScopeChange={setCollectionId}
              base={{ label: t("ai.panel.thisDocumentOnly"), icon: <FileText size={15} /> }}
            />
            {attachments.length > 0 && (
              <div className="ai-attachments">
                {attachments.map((a) => (
                  <div key={a.id} className={`ai-attachment${a.error ? " ai-attachment--error" : ""}`} title={a.error ?? a.name}>
                    <img className="ai-attachment__thumb" src={a.previewUrl} alt={a.name} />
                    {!a.path && !a.error && (
                      <span className="ai-attachment__progress" style={{ ["--p" as string]: `${Math.round(a.progress * 100)}%` }} />
                    )}
                    <button type="button" className="ai-attachment__remove" aria-label={t("ai.panel.removeAttachment", { name: a.name })} onClick={() => removeAttachment(a.id)}>
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
              label={t("ai.panel.attachImage")}
              tooltip={t("ai.panel.attachImageTooltip")}
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
