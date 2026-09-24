/**
 * Create a workspace: a name, and the default access new documents and folders get,
 * preselected to the server's default. Unlike PromptDialog it owns two fields,
 * so reopening resets both.
 */
import { useEffect, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { DEFAULT_DOC_ACCESS, type DocAccessMode } from "@stuga/protocol/domain/workspaces";
import { WORKSPACE_ACCESS_OPTIONS, WORKSPACE_ACCESS_HELP } from "./workspace-access";

interface CreateWorkspaceDialogProps {
  isOpen: boolean;
  onSubmit: (name: string, defaultDocAccess: DocAccessMode) => void;
  onClose: () => void;
}

export function CreateWorkspaceDialog({ isOpen, onSubmit, onClose }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<DocAccessMode>(DEFAULT_DOC_ACCESS);

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setAccess(DEFAULT_DOC_ACCESS);
  }, [isOpen]);

  function submit() {
    const v = name.trim();
    if (!v) return;
    onSubmit(v, access);
    onClose();
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && onClose()} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title="Create a workspace" onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Workspace name"
                placeholder="For example, Team notes"
                value={name}
                onChange={setName}
                isRequired
                hasAutoFocus
                onEnter={submit}
              />
              <Selector
                label="Who can use new documents?"
                description={WORKSPACE_ACCESS_HELP}
                value={access}
                onChange={(v) => setAccess(v as DocAccessMode)}
                options={WORKSPACE_ACCESS_OPTIONS}
              />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="ghost" onClick={onClose} />
              <Button label="Create workspace" variant="primary" isDisabled={!name.trim()} onClick={submit} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
