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
import { StoredSecret } from "./StoredSecret";

const NOTIFY_OPTIONS = [
  { value: "none", label: "Off", description: "Notifications stay in the app." },
  { value: "slack", label: "Slack", description: "Needs an incoming webhook URL." },
  { value: "teams", label: "Microsoft Teams", description: "Needs an incoming webhook URL." },
  { value: "discord", label: "Discord", description: "Needs an incoming webhook URL." },
  { value: "webhook", label: "Plain webhook", description: "Posts JSON to a URL you choose." },
  { value: "email", label: "Email", description: "Needs an SMTP URL and a From address." },
];

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
      status.setNotice({ status: "success", message: "Saved — live now, no restart." });
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
        <Heading level={2}>Notifications</Heading>
        <Text type="supporting" color="secondary">
          Send shares, requests, comments and agent edits outside the app.
        </Text>
        {(ops.notify.webhook_stale || ops.notify.smtp_stale) && (
          <Banner
            status="warning"
            title="A notification credential is missing from this node&apos;s files"
            description="Paste the credential again to restore delivery."
          />
        )}
        <VStack gap={1}>
          <Selector
            label="Deliver to"
            options={NOTIFY_OPTIONS}
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
              label="Webhook URL"
              value={opsForm.webhookUrl}
              isDisabled={clearedSecret.webhook}
              placeholder={ops.notify.webhook_set ? "Leave blank to keep the one on file" : "https://hooks.slack.com/services/…"}
              onChange={(v: string) => setOpsForm({ ...opsForm, webhookUrl: v })}
            />
            <StoredSecret
              onFile={ops.notify.webhook_set ? `On file · ${ops.notify.webhook_label ?? "set"}` : null}
              removed={clearedSecret.webhook}
              onRemove={() => setClearedSecret({ ...clearedSecret, webhook: true })}
              removeLabel="Remove"
              removedNote="It will be removed when you save."
            />
          </VStack>
        )}

        {opsForm.notifySink === "email" && (
          <>
            <VStack gap={1}>
              <TextInput
                label="SMTP URL"
                value={opsForm.smtpUrl}
                isDisabled={clearedSecret.smtp}
                placeholder={ops.notify.smtp_set ? "Leave blank to keep the one on file" : "smtp://user:password@mail.example.com:587"}
                onChange={(v: string) => setOpsForm({ ...opsForm, smtpUrl: v })}
              />
              <StoredSecret
                onFile={ops.notify.smtp_set ? `On file · ${ops.notify.smtp_label ?? "set"}` : null}
                removed={clearedSecret.smtp}
                onRemove={() => setClearedSecret({ ...clearedSecret, smtp: true })}
                removeLabel="Remove"
                removedNote="It will be removed when you save."
              />
            </VStack>
            <TextInput
              label="From address"
              value={opsForm.emailFrom}
              onChange={(v: string) => setOpsForm({ ...opsForm, emailFrom: v })}
            />
          </>
        )}

        <Text type="supporting" color="secondary">
          Credentials live in the data directory, not database backups.
        </Text>

        <HStack gap={2} vAlign="center">
          <Button
            label="Save"
            variant="primary"
            size="sm"
            isLoading={opsBusy === "notify"}
            onClick={() => void runOpsSave()}
          />
          <Button
            label="Send a test"
            variant="secondary"
            size="sm"
            isDisabled={opsForm.notifySink === "none"}
            isLoading={opsBusy === "notify-test"}
            onClick={() => void onNotifyTest()}
          />
          {opsForm.notifySink === "none" && (
            <Text type="supporting" color="secondary">
              In-app only.
            </Text>
          )}
        </HStack>
        {notifyProbe && (
          <Banner
            status={notifyProbe.ok ? "success" : "error"}
            title={notifyProbe.ok ? `Sent to ${notifyProbe.sink}` : `${notifyProbe.sink} did not accept it`}
            {...(notifyProbe.message ? { description: notifyProbe.message } : {})}
          />
        )}
      </VStack>
    </>
  );
}
