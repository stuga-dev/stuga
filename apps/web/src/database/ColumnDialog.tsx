/**
 * Add a column, or change an existing column's type (and its choices). A type
 * change warns that values which don't fit become empty. A new column may carry
 * a description; changing one afterwards is ColumnDescriptionDialog's job, so a
 * retype stays about the type.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Selector } from "@astryxdesign/core/Selector";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { validateSelectChoices } from "@stuga/protocol/databases/cells";
import { DATABASE_MAX_COLUMN_DESCRIPTION_CHARS } from "@stuga/protocol/databases/limits";
import type { ColumnSpec, DatabaseColumnType } from "@stuga/protocol/databases/types";
import { COLUMN_TYPES } from "./model/column-types";

export interface ColumnDialogSubmit {
  display: string;
  type: DatabaseColumnType;
  choices?: string[];
  /** Trimmed, and absent when the field was left empty. Add only: a retype never carries it. */
  description?: string;
}

interface ColumnDialogProps {
  isOpen: boolean;
  /** null adds a column. */
  retypeOf: ColumnSpec | null;
  busy: boolean;
  onSubmit: (spec: ColumnDialogSubmit) => void;
  onClose: () => void;
}

export function ColumnDialog({ isOpen, retypeOf, busy, onSubmit, onClose }: ColumnDialogProps) {
  const [display, setDisplay] = useState("");
  const [type, setType] = useState<DatabaseColumnType>("text");
  const [choicesText, setChoicesText] = useState("");
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setDisplay(retypeOf?.display ?? "");
    setType(retypeOf?.type ?? "text");
    setChoicesText(retypeOf?.options?.choices?.join(", ") ?? "");
    setChoicesError(null);
    setDescription("");
  }, [isOpen, retypeOf]);

  function parseChoices(): string[] {
    return [...new Set(choicesText.split(",").map((c) => c.trim()).filter(Boolean))];
  }

  const trimmedDescription = description.trim();
  const descriptionTooLong = trimmedDescription.length > DATABASE_MAX_COLUMN_DESCRIPTION_CHARS;

  function submit() {
    const name = display.trim();
    if (!retypeOf && !name) return;
    if (!retypeOf && descriptionTooLong) return;
    let choices: string[] | undefined;
    if (type === "single_select") {
      const parsed = parseChoices();
      const v = validateSelectChoices(parsed);
      if (!v.ok) {
        setChoicesError(v.reason);
        return;
      }
      choices = v.choices;
    }
    onSubmit({
      display: retypeOf?.display ?? name,
      type,
      choices,
      // A retype is about the type alone; the description has its own dialog.
      description: retypeOf || !trimmedDescription ? undefined : trimmedDescription,
    });
  }

  // Dropping a choice empties its cells just as a type change would.
  const removesChoices =
    retypeOf?.type === "single_select" &&
    type === "single_select" &&
    (() => {
      const next = new Set(parseChoices());
      return (retypeOf.options?.choices ?? []).some((c) => !next.has(c));
    })();
  const showClearWarning = retypeOf !== null && (retypeOf.type !== type || removesChoices);

  const title = retypeOf ? `Change type of “${retypeOf.display}”` : "Add column";
  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && !busy && onClose()} purpose="form" width={440}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={(o) => !o && !busy && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {!retypeOf && (
                <TextInput
                  label="Column name"
                  value={display}
                  onChange={setDisplay}
                  hasAutoFocus
                  onEnter={submit}
                />
              )}
              <Selector
                label="Type"
                options={[...COLUMN_TYPES]}
                value={type}
                onChange={(v) => {
                  setType(v as DatabaseColumnType);
                  setChoicesError(null);
                }}
              />
              {type === "single_select" && (
                <TextInput
                  label="Choices"
                  description="Comma-separated, e.g. Todo, Doing, Done"
                  value={choicesText}
                  onChange={(v) => {
                    setChoicesText(v);
                    setChoicesError(null);
                  }}
                  onEnter={submit}
                  status={choicesError ? { type: "error", message: choicesError } : undefined}
                />
              )}
              {!retypeOf && (
                <TextArea
                  label="Description"
                  description="Shown in the header and used by AI answers."
                  isOptional
                  rows={3}
                  value={description}
                  onChange={setDescription}
                  status={
                    descriptionTooLong
                      ? {
                          type: "error",
                          message: `Too long: ${trimmedDescription.length.toLocaleString()} characters, and the limit is ${DATABASE_MAX_COLUMN_DESCRIPTION_CHARS.toLocaleString()}.`,
                        }
                      : undefined
                  }
                />
              )}
              {showClearWarning && (
                <Banner
                  status="warning"
                  title="Some values may be cleared"
                  description={
                    removesChoices && retypeOf?.type === type
                      ? "Cells holding a removed choice become empty. This can't be undone."
                      : "Values that don't fit the new type become empty. This can't be undone."
                  }
                />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="ghost" onClick={onClose} isDisabled={busy} />
              <Button
                label={retypeOf ? "Change type" : "Add column"}
                variant="primary"
                onClick={submit}
                isDisabled={busy || (!retypeOf && (!display.trim() || descriptionTooLong))}
                isLoading={busy}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
