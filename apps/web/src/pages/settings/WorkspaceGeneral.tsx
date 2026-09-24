/** A workspace's name and its default document access. Members see it read-only. */
import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { VStack } from "@astryxdesign/core/VStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { DEFAULT_DOC_ACCESS, type DocAccessMode } from "@stuga/protocol/domain/workspaces";
import { WORKSPACE_ACCESS_OPTIONS } from "../../shell/workspace-access";
import { useSettingsScope } from "./SettingsLayout";
import { PageColumn } from "../../ui/PageColumn";
import { Workspaces } from "../../api";
import { setActiveWorkspace } from "../../lib/session/workspace-pointer";
import { errorMessage } from "../../lib/http/client";

export function WorkspaceGeneral() {
  const toast = useToast();
  const { isReady, workspace, canManage, isOwner, reload } = useSettingsScope();
  const [name, setName] = useState("");
  const [defaultAccess, setDefaultAccess] = useState<DocAccessMode>(DEFAULT_DOC_ACCESS);
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  // Re-seeded on a workspace switch.
  useEffect(() => {
    if (!workspace) return;
    setName(workspace.name);
    setDefaultAccess(workspace.default_doc_access);
  }, [workspace?.workspace_id, workspace?.name, workspace?.default_doc_access]);

  if (!isReady || !workspace) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label="Loading…" />
        </VStack>
      </PageColumn>
    );
  }

  async function save() {
    if (!workspace) return;
    setBusy(true);
    try {
      await Workspaces.update(workspace.workspace_id, { name: name.trim(), default_doc_access: defaultAccess });
      await reload();
      toast({ body: "Workspace settings saved.", type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't save settings."), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function deleteWorkspace() {
    if (!workspace) return;
    setBusy(true);
    try {
      await Workspaces.deleteWorkspace(workspace.workspace_id, deleteConfirm);
      // The server resolves the caller's next workspace, or sends them to onboarding.
      setActiveWorkspace(null);
      window.location.assign("/");
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't delete the workspace."), type: "error" });
      setBusy(false);
    }
  }

  return (
    <PageColumn>
      <VStack gap={6}>
        <VStack gap={3}>
          <Heading level={2}>General</Heading>
          <TextInput label="Workspace name" value={name} onChange={setName} isDisabled={!canManage} />
          <VStack gap={0}>
            <Text color="secondary">Default access for new documents and folders</Text>
            <Selector
              label="Default document access"
              isLabelHidden
              value={defaultAccess}
              onChange={(v) => setDefaultAccess(v as DocAccessMode)}
              options={WORKSPACE_ACCESS_OPTIONS}
              isDisabled={!canManage}
            />
            <Text size="sm" color="secondary">
              Guests only see items shared with them.
            </Text>
          </VStack>
          {canManage && (
            <HStack justify="end">
              <Button label="Save" variant="primary" onClick={save} isLoading={busy} />
            </HStack>
          )}
        </VStack>

        {isOwner && (
          <>
            <Divider />
            <VStack gap={3}>
              <Heading level={2}>Danger zone</Heading>
              <Text color="secondary">
                Permanently deletes all content, members and agent keys. Type the workspace name to confirm.
              </Text>
              <HStack gap={2} vAlign="end">
                <StackItem size="fill">
                  <TextInput
                    label="Workspace name"
                    isLabelHidden
                    width="100%"
                    value={deleteConfirm}
                    onChange={setDeleteConfirm}
                    placeholder={workspace.name}
                  />
                </StackItem>
                <Button
                  label="Delete workspace"
                  variant="destructive"
                  isDisabled={deleteConfirm !== workspace.name}
                  onClick={deleteWorkspace}
                  isLoading={busy}
                />
              </HStack>
            </VStack>
          </>
        )}
      </VStack>
    </PageColumn>
  );
}
