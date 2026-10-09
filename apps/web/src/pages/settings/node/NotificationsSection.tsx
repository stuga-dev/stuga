import { useState } from "react";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Banner } from "@astryxdesign/core/Banner";
import { isWebhookSink } from "@stuga/protocol/domain/notify";
import { NodeSettings as NodeApi, type NodeOperationalSettings, type NotifyProbe } from "../../../api";
import { notifyInput, toOpsForm, type OpsForm } from "./ops-form";
import { SectionStatusBanners, useSectionStatus } from "./status";
import { onFileBadge, StoredSecret } from "./StoredSecret";
import { t } from "../../../i18n/i18n";
import { presentServerMessage } from "../../../lib/http/server-messages";

function notifyOptions() {
  return [
    { value: "none", label: t("nodeAccess.notify.off"), description: t("nodeAccess.notify.offHelp") },
    { value: "slack", label: "Slack", description: t("nodeAccess.notify.webhookHelp") }, // i18n-exempt: a product name
    { value: "teams", label: "Microsoft Teams", description: t("nodeAccess.notify.webhookHelp") }, // i18n-exempt: a product name
    { value: "discord", label: "Discord", description: t("nodeAccess.notify.webhookHelp") }, // i18n-exempt: a product name
    { value: "webhook", label: t("nodeAccess.notify.plainWebhook"), description: t("nodeAccess.notify.plainWebhookHelp") },
    { value: "email", label: t("nodeAccess.notify.email"), description: t("nodeAccess.notify.emailHelp") },
  ];
}

export function NotificationsSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (ops: NodeOperationalSettings) => void }) {
  const status = useSectionStatus();
  const [opsForm, setOpsForm] = useState<OpsForm>(() => toOpsForm(ops));
  /** Credentials are write-only: a blank field means "keep what is on file". */
  const [clearedSecret, setClearedSecret] = useState({ webhook: false, smtp: false });
  const [opsBusy, setOpsBusy] = useState<"" | "notify" | "notify-test">("");
  const [notifyProbe, setNotifyProbe] = useState<NotifyProbe | null>(null);

  async function runOpsSave() {
    setOpsBusy("notify");
    status.clear();
    try {
      const res = await NodeApi.saveSettings(notifyInput(opsForm, clearedSecret));
      onSaved(res);
      setOpsForm(toOpsForm(res));
      setClearedSecret({ webhook: false, smtp: false });
      status.setNotice({ status: "success", message: t("common.savedLive") });
    } catch (e) {
      status.fail(e);
    } finally {
      setOpsBusy("");
    }
  }

  async function onNotifyTest() {
    setOpsBusy("notify-test");
    status.clear();
    try {
      setNotifyProbe(await NodeApi.testNotify(notifyInput(opsForm, clearedSecret)));
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
        <Heading level={2}>{t("common.notifications")}</Heading>
        <Text type="supporting" color="secondary">
          {t("nodeAccess.notify.intro")}
        </Text>
        {(ops.notify.webhook_stale || ops.notify.smtp_stale) && (
          <Banner
            status="warning"
            title={t("nodeAccess.notify.credentialStale")}
            description={t("nodeAccess.notify.credentialStaleHelp")}
          />
        )}
        <VStack gap={1}>
          <Selector
            label={t("nodeAccess.notify.deliverTo")}
            options={notifyOptions()}
            value={opsForm.notifySink}
            onChange={(v: string) => {
              // A URL typed for one sink must not travel with a save
              // for another, and a pending removal must not outlive
              // the field that showed it.
              setOpsForm({ ...opsForm, notifySink: v, webhookUrl: "", smtpUrl: "" });
              setClearedSecret({ webhook: false, smtp: false });
            }}
          />
        </VStack>

        {isWebhookSink(opsForm.notifySink) && (
          <VStack gap={1}>
            <TextInput
              label={t("nodeAccess.notify.webhookUrl")}
              value={opsForm.webhookUrl}
              isDisabled={clearedSecret.webhook}
              placeholder={ops.notify.webhook_set ? t("nodeAccess.secret.keepOnFile") : "https://hooks.slack.com/services/…"}
              onChange={(v: string) => setOpsForm({ ...opsForm, webhookUrl: v })}
            />
            <StoredSecret
              onFile={ops.notify.webhook_set ? onFileBadge(ops.notify.webhook_label) : null}
              removed={clearedSecret.webhook}
              onRemove={() => setClearedSecret({ ...clearedSecret, webhook: true })}
              removeLabel={t("common.remove")}
              removedNote={t("nodeAccess.secret.removedNote")}
            />
          </VStack>
        )}

        {opsForm.notifySink === "email" && (
          <>
            <VStack gap={1}>
              <TextInput
                label={t("nodeAccess.notify.smtpUrl")}
                value={opsForm.smtpUrl}
                isDisabled={clearedSecret.smtp}
                placeholder={ops.notify.smtp_set ? t("nodeAccess.secret.keepOnFile") : "smtp://user:password@mail.example.com:587"}
                onChange={(v: string) => setOpsForm({ ...opsForm, smtpUrl: v })}
              />
              <StoredSecret
                onFile={ops.notify.smtp_set ? onFileBadge(ops.notify.smtp_label) : null}
                removed={clearedSecret.smtp}
                onRemove={() => setClearedSecret({ ...clearedSecret, smtp: true })}
                removeLabel={t("common.remove")}
                removedNote={t("nodeAccess.secret.removedNote")}
              />
            </VStack>
            <TextInput
              label={t("nodeAccess.notify.fromAddress")}
              value={opsForm.emailFrom}
              onChange={(v: string) => setOpsForm({ ...opsForm, emailFrom: v })}
            />
          </>
        )}

        <Text type="supporting" color="secondary">
          {t("nodeAccess.notify.credentialsWhere")}
        </Text>

        <HStack gap={2} vAlign="center">
          <Button
            label={t("common.save")}
            variant="primary"
            size="sm"
            isLoading={opsBusy === "notify"}
            onClick={() => void runOpsSave()}
          />
          <Button
            label={t("nodeAccess.notify.sendTest")}
            variant="secondary"
            size="sm"
            isDisabled={opsForm.notifySink === "none"}
            isLoading={opsBusy === "notify-test"}
            onClick={() => void onNotifyTest()}
          />
          {opsForm.notifySink === "none" && (
            <Text type="supporting" color="secondary">
              {t("nodeAccess.notify.inAppOnly")}
            </Text>
          )}
        </HStack>
        {notifyProbe && (
          <Banner
            status={notifyProbe.ok ? "success" : "error"}
            title={notifyProbe.ok ? t("nodeAccess.notify.sent", { sink: notifyProbe.sink }) : t("nodeAccess.notify.refused", { sink: notifyProbe.sink })}
            {...(notifyProbe.message ? { description: presentServerMessage(notifyProbe.message) } : {})}
          />
        )}
      </VStack>
    </>
  );
}
