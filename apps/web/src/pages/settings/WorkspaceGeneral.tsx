/** A workspace's name, its default document access and its export. Members see it read-only. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { VStack } from "@astryxdesign/core/VStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "../../ui/use-toast";
import { DEFAULT_DOC_ACCESS, type DocAccessMode } from "@stuga/protocol/domain/workspaces";
import { WORKSPACE_ACCESS_HELP, WORKSPACE_ACCESS_LABEL, WORKSPACE_ACCESS_OPTIONS } from "../../shell/workspace-access";
import { useSettingsScope } from "./SettingsLayout";
import { PageColumn } from "../../ui/PageColumn";
import { SettingsTitle } from "./SettingsTitle";
import { Workspaces } from "../../api";
import { setActiveWorkspace } from "../../lib/session/workspace-pointer";
import { leaveNotice } from "../../lib/session/notice";
import { saveBlob } from "../../lib/download";
import { errorMessage } from "../../lib/http/client";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

export function WorkspaceGeneral() {
  const toast = useToast();
  const nav = useNavigate();
  const { isReady, workspace, canManage, isOwner, isNodeAdmin, reload } = useSettingsScope();
  const [name, setName] = useState("");
  const [defaultAccess, setDefaultAccess] = useState<DocAccessMode>(DEFAULT_DOC_ACCESS);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
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
          <Spinner label={t("common.loading")} />
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
      toast({ body: t("settings.general.saved"), type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.general.saveFailed")), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function exportWorkspace() {
    if (!workspace) return;
    setExporting(true);
    try {
      const { blob, filename } = await Workspaces.exportArchive(workspace.workspace_id);
      saveBlob(blob, filename);
      toast({ body: t("settings.general.exported", { file: filename }), type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.general.exportFailed")), type: "error" });
    } finally {
      setExporting(false);
    }
  }

  async function deleteWorkspace() {
    if (!workspace) return;
    setBusy(true);
    try {
      await Workspaces.deleteWorkspace(workspace.workspace_id, deleteConfirm);
      // The server resolves the caller's next workspace, or sends them to onboarding; the notice shows there.
      leaveNotice(t("settings.general.deleted", { name: workspace.name }));
      setActiveWorkspace(null);
      window.location.assign("/");
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.general.deleteFailed")), type: "error" });
      setBusy(false);
    }
  }

  return (
    <PageColumn>
      <VStack gap={6}>
        <VStack gap={3}>
          <SettingsTitle>{t("settings.general.heading")}</SettingsTitle>
          <TextInput label={t("settings.general.name")} value={name} onChange={setName} isDisabled={!canManage} />
          <VStack gap={1}>
            <Selector
              label={WORKSPACE_ACCESS_LABEL}
              description={WORKSPACE_ACCESS_HELP}
              value={defaultAccess}
              onChange={(v) => setDefaultAccess(v as DocAccessMode)}
              options={WORKSPACE_ACCESS_OPTIONS}
              isDisabled={!canManage}
            />
            <Text size="sm" color="secondary">
              {t("settings.general.guestsNote")}
            </Text>
          </VStack>
          {canManage && (
            <HStack justify="end">
              <Button label={t("common.save")} variant="primary" onClick={save} isLoading={busy} />
            </HStack>
          )}
        </VStack>

        {canManage && (
          <>
            <Divider />
            <VStack gap={3}>
              <Heading level={2}>{t("settings.general.exportHeading")}</Heading>
              <Text color="secondary">{t("settings.general.exportNote")}</Text>
              {/* Backups are the node's, so only its administrators can open them. */}
              {isNodeAdmin && (
                <Text color="secondary">
                  {tRich("settings.general.exportBackups", { link: (chunks) => <Link onClick={() => nav("/settings/node/backups")}>{chunks}</Link> })}
                </Text>
              )}
              <HStack justify="end">
                <Button label={t("settings.general.exportButton")} onClick={exportWorkspace} isLoading={exporting} />
              </HStack>
            </VStack>
          </>
        )}

        {isOwner && (
          <>
            {/* Outlined in the error colour, so it reads as dangerous before anything is typed; the outline separates it. */}
            <VStack gap={3} padding={4} className="settings-danger-zone">
              <Heading level={2}>{t("settings.general.dangerHeading")}</Heading>
              <Text color="secondary">{t("settings.general.dangerNote")}</Text>
              <HStack gap={2} vAlign="end">
                <StackItem size="fill">
                  {/* No placeholder: the name in grey read as already typed. The label says what to type. */}
                  <TextInput
                    label={t("settings.general.deleteConfirm", { name: workspace.name })}
                    width="100%"
                    value={deleteConfirm}
                    onChange={setDeleteConfirm}
                  />
                </StackItem>
                <Button
                  label={t("settings.general.delete")}
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
