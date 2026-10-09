import { useEffect, useState } from "react";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import {
  NodeSettings as NodeApi,
  type NodeOperationalSettings,
  type NodeOperationalSettingsInput,
  type NodeStorage,
} from "../../../api";
import { t } from "../../../i18n/i18n";
import { byteSize } from "../../../lib/format";
import { toOpsForm, type OpsForm } from "./ops-form";
import { SectionStatusBanners, useSectionStatus } from "./status";

/** What the node takes on disk, then upload size and retention, each card with its own save. */
export function StorageSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (ops: NodeOperationalSettings) => void }) {
  const status = useSectionStatus();
  const [opsForm, setOpsForm] = useState<OpsForm>(() => toOpsForm(ops));
  const [opsBusy, setOpsBusy] = useState<"" | "limits" | "maintenance">("");
  const [disk, setDisk] = useState<NodeStorage | null>(null);

  // Measured each time the section is shown.
  useEffect(() => {
    let live = true;
    NodeApi.storage()
      .then((d) => live && setDisk(d))
      .catch((e: unknown) => live && status.fail(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runOpsSave(group: "limits" | "maintenance") {
    setOpsBusy(group);
    status.clear();
    const input: NodeOperationalSettingsInput =
      group === "limits"
        ? { limits: { max_upload_mb: opsForm.maxUploadMb } }
        : {
            maintenance: {
              audit_retention_days: opsForm.auditRetentionDays,
              database_ops_keep: opsForm.databaseOpsKeep,
              ai_usage_retention_days: opsForm.aiUsageRetentionDays,
              ask_thread_retention_days: opsForm.askThreadRetentionDays,
            },
          };
    try {
      const res = await NodeApi.saveSettings(input);
      onSaved(res);
      setOpsForm(toOpsForm(res));
      status.setNotice({ status: "success", message: t("common.savedLive") });
    } catch (e) {
      status.fail(e);
    } finally {
      setOpsBusy("");
    }
  }

  return (
    <>
      <SectionStatusBanners status={status} />
      <VStack gap={3}>
        <Heading level={2}>{t("node.storage.disk")}</Heading>
        <Text type="supporting" color="secondary">{t("node.storage.diskNote")}</Text>
        {disk ? (
          <MetadataList columns="single" label={{ position: "start" }}>
            <MetadataListItem label={t("common.database")}>{byteSize(disk.database_bytes)}</MetadataListItem>
            <MetadataListItem label={t("node.storage.files")}>{byteSize(disk.files_bytes)}</MetadataListItem>
            {disk.backups_bytes !== null && <MetadataListItem label={t("node.storage.backups")}>{byteSize(disk.backups_bytes)}</MetadataListItem>}
            <MetadataListItem label={t("node.storage.free")}>{byteSize(disk.free_bytes)}</MetadataListItem>
          </MetadataList>
        ) : (
          <Text type="supporting" color="secondary">
            {t("node.storage.measuring")}
          </Text>
        )}
      </VStack>

      <Divider />

      <VStack gap={3}>
        <Heading level={2}>{t("node.storage.uploads")}</Heading>
        <Text type="supporting" color="secondary">{t("node.storage.uploadsNote")}</Text>
        <VStack gap={1}>
          <NumberInput
            label={t("node.storage.maxUpload")}
            units={t("node.storage.mb")}
            min={1}
            max={ops.limits.ceiling_mb}
            isIntegerOnly
            value={opsForm.maxUploadMb}
            onChange={(v: number) => setOpsForm({ ...opsForm, maxUploadMb: v })}
          />
          <Text type="supporting" color="secondary">
            {t("node.storage.uploadCeiling", { mb: ops.limits.ceiling_mb })}
          </Text>
        </VStack>
        <HStack gap={2} vAlign="center">
          <Button
            label={t("common.save")}
            variant="primary"
            size="sm"
            isLoading={opsBusy === "limits"}
            onClick={() => void runOpsSave("limits")}
          />
        </HStack>
      </VStack>

      <Divider />

      <VStack gap={3}>
        <Heading level={2}>{t("node.storage.auditRetention")}</Heading>
        <Text type="supporting" color="secondary">
          {t("node.storage.auditRetentionNote")}
        </Text>
        <VStack gap={1}>
          <NumberInput
            label={t("node.storage.auditKeep")}
            units={t("node.storage.days")}
            min={0}
            isIntegerOnly
            value={opsForm.auditRetentionDays}
            onChange={(v: number) => setOpsForm({ ...opsForm, auditRetentionDays: v })}
          />
        </VStack>
        <Heading level={2}>{t("node.storage.databaseActivity")}</Heading>
        <Text type="supporting" color="secondary">
          {t("node.storage.databaseActivityNote")}
        </Text>
        <VStack gap={1}>
          <NumberInput
            label={t("node.storage.databaseKeep")}
            units={t("node.storage.changes")}
            min={0}
            isIntegerOnly
            value={opsForm.databaseOpsKeep}
            onChange={(v: number) => setOpsForm({ ...opsForm, databaseOpsKeep: v })}
          />
        </VStack>
        <Heading level={2}>{t("node.storage.aiUsage")}</Heading>
        <Text type="supporting" color="secondary">
          {t("node.storage.aiUsageNote")}
        </Text>
        <VStack gap={1}>
          <NumberInput
            label={t("node.storage.aiUsageKeep")}
            units={t("node.storage.days")}
            min={0}
            isIntegerOnly
            value={opsForm.aiUsageRetentionDays}
            onChange={(v: number) => setOpsForm({ ...opsForm, aiUsageRetentionDays: v })}
          />
        </VStack>
        <Heading level={2}>{t("node.storage.askThreads")}</Heading>
        <Text type="supporting" color="secondary">
          {t("node.storage.askThreadsNote")}
        </Text>
        <VStack gap={1}>
          <NumberInput
            label={t("node.storage.askThreadsKeep")}
            units={t("node.storage.days")}
            min={0}
            isIntegerOnly
            value={opsForm.askThreadRetentionDays}
            onChange={(v: number) => setOpsForm({ ...opsForm, askThreadRetentionDays: v })}
          />
        </VStack>
        <HStack gap={2} vAlign="center">
          <Button
            label={t("common.save")}
            variant="primary"
            size="sm"
            isLoading={opsBusy === "maintenance"}
            onClick={() => void runOpsSave("maintenance")}
          />
        </HStack>
      </VStack>
    </>
  );
}
