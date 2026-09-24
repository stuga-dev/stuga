/**
 * What one column holds, in prose. A column's name and type don't say that, and
 * the text is read twice over: by whoever is reading the table, and by the AI
 * grounding a question about it. Only a person may change it — agents are
 * refused here exactly as they are on rename and retype.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";
import { DATABASE_MAX_COLUMN_DESCRIPTION_CHARS } from "@stuga/protocol/databases/limits";
import type { ColumnSpec } from "@stuga/protocol/databases/types";
import { Databases } from "../api";

interface ColumnDescriptionDialogProps {
  isOpen: boolean;
  docId: string;
  tableId: string;
  /** null while the dialog is closed; it stays mounted between openings. */
  column: ColumnSpec | null;
  /** The schema changed: ask the page to refetch it. */
  onSaved: () => void;
  /** The grid's shared surfacing, so a 403 also turns the page read-only. */
  onError: (e: unknown, fallback: string) => void;
  onClose: () => void;
}

export function ColumnDescriptionDialog({
  isOpen,
  docId,
  tableId,
  column,
  onSaved,
  onError,
  onClose,
}: ColumnDescriptionDialogProps) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  // The dialog keeps its content mounted, so every opening re-seeds from the column on screen.
  useEffect(() => {
    if (!isOpen) return;
    setText(column?.description ?? "");
    setSaving(false);
  }, [isOpen, column]);

  const saved = column?.description ?? "";
  const trimmed = text.trim();
  // The server stores the trimmed text and refuses anything longer, so say so here rather than on a 400.
  const tooLong = trimmed.length > DATABASE_MAX_COLUMN_DESCRIPTION_CHARS;
  const canSave = column !== null && !saving && !tooLong && trimmed !== saved;

  async function save() {
    if (!canSave || column === null) return;
    setSaving(true);
    try {
      await Databases.setColumnDescription(docId, tableId, column.column_id, trimmed);
      onSaved();
      onClose();
    } catch (e) {
      onError(e, "Couldn’t save the description.");
    } finally {
      setSaving(false);
    }
  }

  // Nothing closes while a save is in flight: a late answer would otherwise land on the next column's opening.
  const close = () => !saving && onClose();

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={460}>
      <Layout
        header={
          <DialogHeader title="Column description" subtitle={column?.display ?? ""} onOpenChange={(o) => !o && close()} />
        }
        content={
          <LayoutContent>
            <VStack gap={3}>
              <TextArea
                label="Description"
                description="Shown in the header and used by AI answers."
                rows={4}
                value={text}
                onChange={setText}
                isDisabled={saving}
                hasAutoFocus
                status={
                  tooLong
                    ? {
                        type: "error",
                        message: `Too long: ${trimmed.length.toLocaleString()} characters, and the limit is ${DATABASE_MAX_COLUMN_DESCRIPTION_CHARS.toLocaleString()}.`,
                      }
                    : undefined
                }
              />
              <Text type="supporting" color="secondary">
                Leave it empty to remove the description.
              </Text>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="ghost" onClick={close} isDisabled={saving} />
              <Button label="Save" variant="primary" onClick={() => void save()} isDisabled={!canSave} isLoading={saving} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
