/**
 * A single-field prompt that submits the trimmed value. No placeholder: grey
 * example text reads as a value already entered; `initialValue` seeds a real one,
 * selected as the dialog opens so typing replaces it.
 */
import { useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { t } from "../i18n/i18n";
import { selectOnFocus } from "./select-on-focus";
import { isComposingKey } from "../lib/ime";

interface PromptDialogProps {
  isOpen: boolean;
  title: string;
  label: string;
  initialValue?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export function PromptDialog({
  isOpen,
  title,
  label,
  initialValue = "",
  submitLabel = t("common.create"),
  onSubmit,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  // Seeded while rendering, not in an effect: the dialog focuses the field as it opens, and
  // the selection made then must cover the new value, not the last opening's.
  const [seeded, setSeeded] = useState({ isOpen, initialValue });
  if (seeded.isOpen !== isOpen || seeded.initialValue !== initialValue) {
    setSeeded({ isOpen, initialValue });
    if (isOpen) setValue(initialValue);
  }

  function submit() {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    onClose();
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && onClose()} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <TextInput
              label={label}
              value={value}
              onChange={setValue}
              hasAutoFocus
              onFocus={selectOnFocus}
              onEnter={submit}
              // The dialog closes on this Enter and hands focus back to what opened it, a menu's
              // button often; left alone, the key would then press that button and reopen the menu.
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isComposingKey(e)) e.preventDefault();
              }}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label={t("common.cancel")} variant="ghost" onClick={onClose} />
              <Button label={submitLabel} variant="primary" onClick={submit} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
