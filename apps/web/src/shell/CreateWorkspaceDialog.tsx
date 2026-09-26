/**
 * Create a workspace: a name, the default access new documents and folders get, preselected
 * to the server's default, and what it starts with, the samples asked for as it opens. Reopening
 * resets every field. The dialog stays open while the workspace is made, and says so there if it
 * could not be, or if an import it stopped waiting for may still finish.
 */
import { useEffect, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { DEFAULT_DOC_ACCESS, type DocAccessMode } from "@stuga/protocol/domain/workspaces";
import { errorMessage } from "../lib/http/client";
import {
  ARCHIVE_NAME_PLACEHOLDER,
  ImportMayFinish,
  StartWith,
  useBannerInView,
  useNewWorkspace,
  useWorkspaceSamples,
  type StartChoice,
} from "./StartWith";
import { WORKSPACE_ACCESS_OPTIONS, WORKSPACE_ACCESS_HELP } from "./workspace-access";

interface CreateWorkspaceDialogProps {
  isOpen: boolean;
  /** Settles once the workspace exists; a rejection is shown here, and the dialog stays open. */
  onSubmit: (name: string, defaultDocAccess: DocAccessMode, start: StartChoice) => Promise<void>;
  onClose: () => void;
}

export function CreateWorkspaceDialog({ isOpen, onSubmit, onClose }: CreateWorkspaceDialogProps) {
  const { name, setName, start, setStart, reset, ready, nameOptional } = useNewWorkspace();
  const samples = useWorkspaceSamples(isOpen);
  const [access, setAccess] = useState<DocAccessMode>(DEFAULT_DOC_ACCESS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useBannerInView(error);
  /** An import the browser stopped waiting for may still finish: no second is asked for from here. */
  const [mayFinish, setMayFinish] = useState(false);
  const mayFinishRef = useBannerInView(mayFinish);

  useEffect(() => {
    if (!isOpen) return;
    reset();
    setAccess(DEFAULT_DOC_ACCESS);
    setBusy(false);
    setError(null);
    setMayFinish(false);
  }, [isOpen, reset]);

  async function submit() {
    if (busy || !ready || mayFinish) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), access, start);
      onClose();
    } catch (err) {
      if (err instanceof ImportMayFinish) setMayFinish(true);
      else setError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setBusy(false);
    }
  }

  // Nothing closes the dialog while the workspace is being made.
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title="Create a workspace" onOpenChange={(o) => !o && close()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {mayFinish && (
                <Banner ref={mayFinishRef} status="info" title="The import may still finish" description="The workspace switcher lists it once it does." />
              )}
              {error && <Banner ref={errorRef} status="error" title="Couldn’t create the workspace" description={error} />}
              <TextInput
                label="Workspace name"
                placeholder={nameOptional ? ARCHIVE_NAME_PLACEHOLDER : "For example, Team notes"}
                value={name}
                onChange={setName}
                isRequired={!nameOptional}
                hasAutoFocus
                isDisabled={busy}
                onEnter={submit}
              />
              <Selector
                label="Who can use new documents?"
                description={WORKSPACE_ACCESS_HELP}
                value={access}
                onChange={(v) => setAccess(v as DocAccessMode)}
                options={WORKSPACE_ACCESS_OPTIONS}
                isDisabled={busy}
              />
              <StartWith value={start} onChange={setStart} samples={samples} isDisabled={busy} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="ghost" onClick={close} isDisabled={busy} />
              <Button label="Create workspace" variant="primary" isDisabled={busy || !ready || mayFinish} isLoading={busy} onClick={submit} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
