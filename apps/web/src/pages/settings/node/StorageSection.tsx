import { useState } from "react";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { NodeSettings as NodeApi, type NodeOperationalSettings, type NodeOperationalSettingsInput } from "../../../api";
import { toOpsForm, type OpsForm } from "./ops-form";
import { SectionStatusBanners, useSectionStatus } from "./status";

/** Upload size and retention, each card with its own save. */
export function StorageSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (ops: NodeOperationalSettings) => void }) {
  const status = useSectionStatus();
  const [opsForm, setOpsForm] = useState<OpsForm>(() => toOpsForm(ops));
  const [opsBusy, setOpsBusy] = useState<"" | "limits" | "maintenance">("");

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
      status.setNotice({ status: "success", message: "Saved — live now, no restart." });
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
        <Heading level={2}>Uploads</Heading>
        <Text type="supporting" color="secondary">The largest file anyone may attach.</Text>
        <VStack gap={1}>
          <NumberInput
            label="Maximum upload size"
            units="MB"
            min={1}
            max={ops.limits.ceiling_mb}
            isIntegerOnly
            value={opsForm.maxUploadMb}
            onChange={(v: number) => setOpsForm({ ...opsForm, maxUploadMb: v })}
          />
          <Text type="supporting" color="secondary">
            At most {ops.limits.ceiling_mb} MB — each upload is held in memory while it arrives.
          </Text>
        </VStack>
        <HStack gap={2} vAlign="center">
          <Button
            label="Save"
            variant="primary"
            size="sm"
            isLoading={opsBusy === "limits"}
            onClick={() => void runOpsSave("limits")}
          />
        </HStack>
      </VStack>

      <Divider />

      <VStack gap={3}>
        <Heading level={2}>Audit retention</Heading>
        <Text type="supporting" color="secondary">
          Days before audit history is purged. 0 keeps it forever.
        </Text>
        <VStack gap={1}>
          <NumberInput
            label="Keep audit history for"
            units="days"
            min={0}
            isIntegerOnly
            value={opsForm.auditRetentionDays}
            onChange={(v: number) => setOpsForm({ ...opsForm, auditRetentionDays: v })}
          />
        </VStack>
        <Heading level={2}>Database activity</Heading>
        <Text type="supporting" color="secondary">
          Changes kept per database. Dropped changes can’t be reverted. 0 keeps all.
        </Text>
        <VStack gap={1}>
          <NumberInput
            label="Keep the most recent"
            units="changes"
            min={0}
            isIntegerOnly
            value={opsForm.databaseOpsKeep}
            onChange={(v: number) => setOpsForm({ ...opsForm, databaseOpsKeep: v })}
          />
        </VStack>
        <Heading level={2}>AI usage history</Heading>
        <Text type="supporting" color="secondary">
          Days to keep per-call usage records. 0 keeps them forever.
        </Text>
        <VStack gap={1}>
          <NumberInput
            label="Keep AI usage records for"
            units="days"
            min={0}
            isIntegerOnly
            value={opsForm.aiUsageRetentionDays}
            onChange={(v: number) => setOpsForm({ ...opsForm, aiUsageRetentionDays: v })}
          />
        </VStack>
        <Heading level={2}>Ask threads</Heading>
        <Text type="supporting" color="secondary">
          Days to keep idle conversations. 0 keeps them forever.
        </Text>
        <VStack gap={1}>
          <NumberInput
            label="Keep idle Ask threads for"
            units="days"
            min={0}
            isIntegerOnly
            value={opsForm.askThreadRetentionDays}
            onChange={(v: number) => setOpsForm({ ...opsForm, askThreadRetentionDays: v })}
          />
        </VStack>
        <HStack gap={2} vAlign="center">
          <Button
            label="Save"
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
