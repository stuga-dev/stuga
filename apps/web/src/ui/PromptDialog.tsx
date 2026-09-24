/**
 * A single-field prompt that submits the trimmed value. No placeholder: grey
 * example text reads as a value already entered; `initialValue` seeds a real one.
 */
import { useEffect, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";

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
  submitLabel = "Create",
  onSubmit,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (isOpen) setValue(initialValue);
  }, [isOpen, initialValue]);

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
              onEnter={submit}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="ghost" onClick={onClose} />
              <Button label={submitLabel} variant="primary" onClick={submit} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
