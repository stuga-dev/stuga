/**
 * The composer under a selection after "Edit with AI": a quick action or a
 * custom instruction asks the co-author to rewrite just that selection, and the
 * result comes back as a proposal in the document.
 */
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";
import { HStack } from "@astryxdesign/core/HStack";
import { isComposingKey } from "../lib/ime";
import { useAiCoauthor } from "./ai-coauthor-context";
import { t, type MessageKey } from "../i18n/i18n";

// The instructions are sent to the model, so they stay English; the labels are translated.
const QUICK_ACTIONS: { label: MessageKey; instruction: string }[] = [
  // i18n-exempt: an instruction sent to the model
  { label: "ai.editComposer.improve", instruction: "Improve the writing of this text: make it clearer and more polished, but keep the meaning and roughly the same length." },
  // i18n-exempt: an instruction sent to the model
  { label: "ai.editComposer.shorten", instruction: "Make this text more concise without losing its meaning." },
  // i18n-exempt: an instruction sent to the model
  { label: "ai.editComposer.lengthen", instruction: "Expand this text with more detail and explanation." },
  // i18n-exempt: an instruction sent to the model
  { label: "ai.editComposer.fixGrammar", instruction: "Fix any spelling and grammar mistakes in this text. Do not change the wording otherwise." },
];

export function AiEditComposer() {
  const { selectionEdit, submitSelectionEdit, cancelSelectionEdit } = useAiCoauthor();
  const [instruction, setInstruction] = useState("");

  if (!selectionEdit) return null;

  /** `shown` is the transcript's text for a quick action, whose instruction is English for the model. */
  const run = (text: string, shown?: string) => {
    if (!text.trim()) return;
    setInstruction("");
    submitSelectionEdit(text, shown);
  };

  const top = Math.min(selectionEdit.rect.top + 6, window.innerHeight - 220);
  const left = Math.min(selectionEdit.rect.left, window.innerWidth - 310);

  return (
    <div
      className="ai-edit-composer"
      style={{ top, left }}
      role="dialog"
      aria-label={t("ai.editComposer.title")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancelSelectionEdit();
        }
      }}
    >
      <div className="ai-edit-composer__quote" dir="auto" title={selectionEdit.quote}>
        “{selectionEdit.quote}”
      </div>
      <div className="ai-edit-composer__actions">
        {QUICK_ACTIONS.map((a) => (
          <Button
            key={a.label}
            label={t(a.label)}
            variant="secondary"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(a.instruction, t(a.label))}
          />
        ))}
      </div>
      <TextArea
        label={t("ai.editComposer.instructionLabel")}
        isLabelHidden
        hasAutoFocus
        value={instruction}
        placeholder={t("ai.editComposer.instructionPlaceholder")}
        rows={2}
        onChange={setInstruction}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey && !isComposingKey(e)) {
            e.preventDefault();
            run(instruction);
          }
        }}
      />
      <HStack gap={2} justify="end">
        <Button label={t("common.cancel")} variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={cancelSelectionEdit} />
        <Button label={t("ai.editComposer.title")} variant="primary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => run(instruction)} isDisabled={!instruction.trim()} />
      </HStack>
    </div>
  );
}
