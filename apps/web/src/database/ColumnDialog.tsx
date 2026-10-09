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
import { columnTypeOptions } from "./model/column-types";
import { t } from "../i18n/i18n";
import { cellProblem } from "./model/cell-problems";

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
        setChoicesError(cellProblem(v.reason));
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

  const title = retypeOf ? t("database.columnDialog.changeTypeTitle", { name: retypeOf.display }) : t("database.column.add");
  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && !busy && onClose()} purpose="form" width={440}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={(o) => !o && !busy && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {!retypeOf && (
                <TextInput
                  label={t("database.column.name")}
                  value={display}
                  onChange={setDisplay}
                  hasAutoFocus
                  onEnter={submit}
                />
              )}
              <Selector
                label={t("database.columnDialog.type")}
                options={columnTypeOptions()}
                value={type}
                onChange={(v) => {
                  setType(v as DatabaseColumnType);
                  setChoicesError(null);
                }}
              />
              {type === "single_select" && (
                <TextInput
                  label={t("database.columnDialog.choices")}
                  description={t("database.columnDialog.choicesHelp")}
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
                  label={t("database.columnDescription.label")}
                  description={t("database.columnDescription.help")}
                  isOptional
                  rows={3}
                  value={description}
                  onChange={setDescription}
                  status={
                    descriptionTooLong
                      ? {
                          type: "error",
                          message: t("common.tooLong", { count: trimmedDescription.length, limit: DATABASE_MAX_COLUMN_DESCRIPTION_CHARS }),
                        }
                      : undefined
                  }
                />
              )}
              {showClearWarning && (
                <Banner
                  status="warning"
                  title={t("database.columnDialog.clearWarning")}
                  description={
                    removesChoices && retypeOf?.type === type
                      ? t("database.columnDialog.clearChoices")
                      : t("database.columnDialog.clearType")
                  }
                />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label={t("common.cancel")} variant="ghost" onClick={onClose} isDisabled={busy} />
              <Button
                label={retypeOf ? t("database.columnDialog.changeType") : t("database.column.add")}
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
