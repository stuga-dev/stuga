/**
 * Instructions for agents on one folder, document or database: the levels above
 * it read-only, outermost first, then its own text. Agents read the whole stack
 * in that order and nothing overrides anything. Anyone who can read the item may
 * look; the server lets only its owner or a workspace admin save, and the limits
 * checked here only fail fast.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Banner } from "@astryxdesign/core/Banner";
import { Blockquote } from "@astryxdesign/core/Blockquote";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "../ui/use-toast";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import {
  MAX_AGENT_INSTRUCTIONS_STACK_CHARS,
  instructionStackChars,
  instructionTitle,
  type InstructionLevel,
  type InstructionLevelKind,
} from "@stuga/protocol/domain/instructions";
import { Docs, Folders, type ItemInstructions } from "../api";
import { errorMessage } from "../lib/http/client";
import { LoadFailed } from "../ui/LoadFailed";
import { t, type MessageKey } from "../i18n/i18n";

export interface InstructionsTarget {
  kind: "folder" | "document" | "database";
  id: string;
  title: string;
}

const INTRO: Record<InstructionsTarget["kind"], MessageKey> = {
  folder: "library.instructions.introFolder",
  document: "library.instructions.introDocument",
  database: "library.instructions.introDatabase",
};

const LEVEL: Record<InstructionLevelKind, MessageKey> = {
  workspace: "library.instructions.levelWorkspace",
  folder: "library.instructions.levelFolder",
  database: "library.instructions.levelDatabase",
  document: "library.instructions.levelDocument",
};

/** An inherited level as a person reads it: `Folder "Contracts"`, in the interface language. */
export function levelLabel(level: Pick<InstructionLevel, "kind" | "title">): string {
  const blank = level.title.replace(/[\s\p{Cc}]+/gu, "") === "";
  return t(LEVEL[level.kind], { title: blank ? t("common.untitled") : instructionTitle(level.title) });
}

interface InstructionsDialogProps {
  isOpen: boolean;
  target: InstructionsTarget;
  onClose: () => void;
}

export function InstructionsDialog({ isOpen, target, onClose }: InstructionsDialogProps) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<ItemInstructions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  // The dialog stays mounted between openings, so every opening starts from the server's answer.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    setLoaded(null);
    setLoadError(null);
    setText("");
    setSaving(false);
    const load = target.kind === "folder" ? Folders.instructions(target.id) : Docs.instructions(target.id);
    load
      .then((r) => {
        if (!live) return;
        setLoaded(r);
        setText(r.own);
      })
      .catch((e) => live && setLoadError(errorMessage(e, t("library.instructions.loadFallback"))));
    return () => {
      live = false;
    };
  }, [isOpen, target.kind, target.id, attempt]);

  const canEdit = loaded?.can_edit ?? false;
  const tooLong = text.length > MAX_AGENT_INSTRUCTIONS_CHARS;
  const stackTooLong =
    loaded !== null && instructionStackChars(loaded.inherited) + text.trim().length > MAX_AGENT_INSTRUCTIONS_STACK_CHARS;
  const canSave = loaded !== null && canEdit && !saving && !tooLong && text !== loaded.own;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      if (target.kind === "folder") await Folders.setInstructions(target.id, text);
      else await Docs.setState(target.id, { agent_instructions: text });
      toast({ body: t("library.instructions.saved"), type: "info" });
      onClose();
    } catch (e) {
      const status = (e as { status?: number }).status;
      toast({
        body:
          status === 403 ? t("library.instructions.denied") : t("library.instructions.saveFailed"),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  // A row page inherits through its database, which the stack names as its own level.

  let content: ReactNode;
  if (loadError !== null) {
    content = (
      <LoadFailed isCompact title={t("library.instructions.loadFailed")} description={loadError} onRetry={() => setAttempt((n) => n + 1)} />
    );
  } else if (loaded === null) {
    content = (
      <VStack gap={2} hAlign="center">
        <Spinner label={t("common.loading")} />
      </VStack>
    );
  } else {
    content = (
      <VStack gap={4}>
        <Text as="p" display="block" color="secondary">
          {t(INTRO[target.kind])}
        </Text>
        <VStack gap={3}>
          {loaded.inherited.length === 0 ? (
            <Text type="supporting" color="secondary">
              {t("library.instructions.noneInherited")}
            </Text>
          ) : (
            loaded.inherited.map((level) => (
              <VStack key={`${level.kind}:${level.id}`} gap={1}>
                <Text type="label">{levelLabel(level)}</Text>
                <Blockquote>
                  <Text as="p" display="block" color="secondary" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {level.text}
                  </Text>
                </Blockquote>
              </VStack>
            ))
          )}
        </VStack>
        <TextArea
          label={t("library.instructions.fieldLabel", { kind: target.kind })}
          description={canEdit ? undefined : t("library.instructions.readOnly")}
          rows={8}
          value={text}
          onChange={setText}
          isReadOnly={!canEdit}
          isDisabled={saving}
          status={
            tooLong
              ? {
                  type: "error",
                  message: t("common.tooLong", { count: text.length, limit: MAX_AGENT_INSTRUCTIONS_CHARS }),
                }
              : undefined
          }
        />
        {stackTooLong && (
          <Banner
            status="warning"
            title={t("library.instructions.stackWarning")}
            description={t("library.instructions.stackWarningBody", { limit: MAX_AGENT_INSTRUCTIONS_STACK_CHARS })}
          />
        )}
      </VStack>
    );
  }

  // Nothing closes the dialog while a save is in flight: a late answer would otherwise close, or clear
  // the saving state of, the next item's opening.
  const close = () => !saving && onClose();

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={560}>
      <Layout
        header={
          <DialogHeader
            title={t("library.instructions.title")}
            subtitle={target.title.trim() || t("common.untitled")}
            onOpenChange={(o) => !o && close()}
          />
        }
        content={<LayoutContent>{content}</LayoutContent>}
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              {canEdit ? (
                <>
                  <Button label={t("common.cancel")} variant="ghost" onClick={close} isDisabled={saving} />
                  <Button label={t("common.save")} variant="primary" onClick={() => void save()} isDisabled={!canSave} isLoading={saving} />
                </>
              ) : (
                <Button label={t("common.close")} variant="ghost" onClick={onClose} />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
