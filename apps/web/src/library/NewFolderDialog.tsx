/**
 * New folder: its name, and the instructions for agents that will apply inside
 * it. What it inherits from above is shown beside the box, so nobody repeats a
 * convention that already applies. Both travel in the one create call, so a
 * folder never exists for a moment without the conventions it was made for.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Blockquote } from "@astryxdesign/core/Blockquote";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import { Folders } from "../api";
import { t } from "../i18n/i18n";
import { levelLabel } from "./InstructionsDialog";

interface NewFolderDialogProps {
  isOpen: boolean;
  /** The folder it goes in, or null for the top level. */
  parentId?: string | null;
  /** The trimmed name, and the trimmed instructions or "" when none were written. */
  onSubmit: (title: string, instructions: string) => void;
  onClose: () => void;
}

export function NewFolderDialog({ isOpen, parentId = null, onSubmit, onClose }: NewFolderDialogProps) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [inherited, setInherited] = useState<InstructionLevel[]>([]);

  // The dialog stays mounted between openings, so every opening starts empty and asks again.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    setTitle("");
    setInstructions("");
    setInherited([]);
    // What is inherited is context, not a gate: a failed read just shows none.
    Folders.placementInstructions(parentId)
      .then((r) => live && setInherited(r.inherited))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [isOpen, parentId]);

  const tooLong = instructions.trim().length > MAX_AGENT_INSTRUCTIONS_CHARS;

  function submit() {
    const name = title.trim();
    if (!name || tooLong) return;
    onSubmit(name, instructions.trim());
    onClose();
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && onClose()} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title={t("library.create.newFolder")} onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput label={t("library.explorer.folderName")} value={title} onChange={setTitle} hasAutoFocus onEnter={submit} />
              <VStack gap={3}>
                {inherited.length > 0 && (
                  <VStack gap={2}>
                    <Text type="label">{t("library.folder.alreadyApplies")}</Text>
                    {inherited.map((level) => (
                      <VStack key={`${level.kind}:${level.id}`} gap={1}>
                        <Text type="supporting" color="secondary">
                          {levelLabel(level)}
                        </Text>
                        <Blockquote>
                          <Text as="p" display="block" color="secondary" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                            {level.text}
                          </Text>
                        </Blockquote>
                      </VStack>
                    ))}
                  </VStack>
                )}
                <TextArea
                  label={t("library.instructions.title")}
                  isOptional
                  rows={4}
                  value={instructions}
                  onChange={setInstructions}
                  description={
                    inherited.length > 0
                      ? t("library.folder.instructionsAdds")
                      : t("library.folder.instructionsHint")
                  }
                  status={tooLong ? { type: "error", message: t("library.folder.instructionsTooLong", { limit: MAX_AGENT_INSTRUCTIONS_CHARS }) } : undefined}
                />
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label={t("common.cancel")} variant="ghost" onClick={onClose} />
              <Button label={t("common.create")} variant="primary" onClick={submit} isDisabled={!title.trim() || tooLong} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
