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
import { useToast } from "@astryxdesign/core/Toast";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import {
  MAX_AGENT_INSTRUCTIONS_STACK_CHARS,
  instructionLevelLabel,
  instructionStackChars,
} from "@stuga/protocol/domain/instructions";
import { Docs, Folders, type ItemInstructions } from "../api";
import { errorMessage } from "../lib/http/client";
import { LoadFailed } from "../ui/LoadFailed";

export interface InstructionsTarget {
  kind: "folder" | "document" | "database";
  id: string;
  title: string;
}

const INTRO: Record<InstructionsTarget["kind"], string> = {
  folder: "Agents working in this folder",
  document: "Agents working on this document",
  database: "Agents working on this database and its row pages",
};

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
      .catch((e) => live && setLoadError(errorMessage(e, "Please try again in a moment.")));
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
      toast({ body: "Instructions saved. Agents read them on their next turn.", type: "info" });
      onClose();
    } catch (e) {
      const status = (e as { status?: number }).status;
      toast({
        body:
          status === 403
            ? "Only the owner or a workspace admin can change these instructions."
            : "Couldn’t save the instructions. Please try again.",
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
      <LoadFailed isCompact title="Couldn’t load the instructions" description={loadError} onRetry={() => setAttempt((n) => n + 1)} />
    );
  } else if (loaded === null) {
    content = (
      <VStack gap={2} hAlign="center">
        <Spinner label="Loading…" />
      </VStack>
    );
  } else {
    content = (
      <VStack gap={4}>
        <Text as="p" display="block" color="secondary">
          {INTRO[target.kind]} read these after inherited instructions.
          {target.kind === "document" ? "" : ` Only people with access to this ${target.kind} receive them.`}
        </Text>
        <VStack gap={3}>
          {loaded.inherited.length === 0 ? (
            <Text type="supporting" color="secondary">
              Nothing is inherited from above.
            </Text>
          ) : (
            loaded.inherited.map((level) => (
              <VStack key={`${level.kind}:${level.id}`} gap={1}>
                <Text type="label">{instructionLevelLabel(level)}</Text>
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
          label={`Instructions for this ${target.kind}`}
          description={canEdit ? undefined : "Only the owner or a workspace admin can change them."}
          rows={8}
          value={text}
          onChange={setText}
          isReadOnly={!canEdit}
          isDisabled={saving}
          status={
            tooLong
              ? {
                  type: "error",
                  message: `Too long: ${text.length.toLocaleString()} characters, and the limit is ${MAX_AGENT_INSTRUCTIONS_CHARS.toLocaleString()}.`,
                }
              : undefined
          }
        />
        {stackTooLong && (
          <Banner
            status="warning"
            title="Agents won’t read all of this"
            description={`The ${MAX_AGENT_INSTRUCTIONS_STACK_CHARS.toLocaleString()}-character stack limit will truncate the nearest instructions.`}
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
            title="Instructions for agents"
            subtitle={target.title.trim() || "Untitled"}
            onOpenChange={(o) => !o && close()}
          />
        }
        content={<LayoutContent>{content}</LayoutContent>}
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              {canEdit ? (
                <>
                  <Button label="Cancel" variant="ghost" onClick={close} isDisabled={saving} />
                  <Button label="Save" variant="primary" onClick={() => void save()} isDisabled={!canSave} isLoading={saving} />
                </>
              ) : (
                <Button label="Close" variant="ghost" onClick={onClose} />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
