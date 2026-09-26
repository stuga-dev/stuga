/**
 * The composer under a selection after "Edit with AI": a quick action or a
 * custom instruction asks the co-author to rewrite just that selection, and the
 * result comes back as a proposal in the document.
 */
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";
import { HStack } from "@astryxdesign/core/HStack";
import { useAiCoauthor } from "./ai-coauthor-context";

const QUICK_ACTIONS: { label: string; instruction: string }[] = [
  { label: "Improve", instruction: "Improve the writing of this text: make it clearer and more polished, but keep the meaning and roughly the same length." },
  { label: "Shorten", instruction: "Make this text more concise without losing its meaning." },
  { label: "Lengthen", instruction: "Expand this text with more detail and explanation." },
  { label: "Fix grammar", instruction: "Fix any spelling and grammar mistakes in this text. Do not change the wording otherwise." },
];

export function AiEditComposer() {
  const { selectionEdit, submitSelectionEdit, cancelSelectionEdit } = useAiCoauthor();
  const [instruction, setInstruction] = useState("");

  if (!selectionEdit) return null;

  const run = (text: string) => {
    if (!text.trim()) return;
    setInstruction("");
    submitSelectionEdit(text);
  };

  const top = Math.min(selectionEdit.rect.top + 6, window.innerHeight - 220);
  const left = Math.min(selectionEdit.rect.left, window.innerWidth - 310);

  return (
    <div
      className="ai-edit-composer"
      style={{ top, left }}
      role="dialog"
      aria-label="Edit with AI"
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
            label={a.label}
            variant="secondary"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(a.instruction)}
          />
        ))}
      </div>
      <TextArea
        label="Instruction for the AI"
        isLabelHidden
        hasAutoFocus
        value={instruction}
        placeholder="Or describe the change…"
        rows={2}
        onChange={setInstruction}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            run(instruction);
          }
        }}
      />
      <HStack gap={2} justify="end">
        <Button label="Cancel" variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={cancelSelectionEdit} />
        <Button label="Edit with AI" variant="primary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => run(instruction)} isDisabled={!instruction.trim()} />
      </HStack>
    </div>
  );
}
