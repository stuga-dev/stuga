/**
 * The workspace's side of the agent contract: the instructions every agent reads,
 * and webhooks for the event feed. Review mode is set per document.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Table, proportional, pixel } from "@astryxdesign/core/Table";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "../../ui/use-toast";
import { isWorkspaceEventType, type WorkspaceEventType } from "@stuga/protocol/domain/events";
import { useSettingsScope } from "./SettingsLayout";
import { PageColumn } from "../../ui/PageColumn";
import { SettingsTitle } from "./SettingsTitle";
import { relativeTime, absoluteTime, listOf } from "../../lib/format";
import { Folders, Webhooks, Workspaces, type Folder, type WebhookInfo } from "../../api";
import { errorMessage } from "../../lib/http/client";
import { t, type MessageKey } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

const WHOLE_WORKSPACE = "";

const EVENT_LABEL: Record<WorkspaceEventType, MessageKey> = {
  "doc.created": "settings.agents.webhooks.event.docCreated",
  "doc.updated": "settings.agents.webhooks.event.docUpdated",
  "doc.trashed": "settings.agents.webhooks.event.docTrashed",
  "run.proposed": "settings.agents.webhooks.event.runProposed",
  "run.applied": "settings.agents.webhooks.event.runApplied",
  "run.decided": "settings.agents.webhooks.event.runDecided",
  "run.reverted": "settings.agents.webhooks.event.runReverted",
  "run.reopened": "settings.agents.webhooks.event.runReopened",
  "comment.added": "settings.agents.webhooks.event.commentAdded",
  "database.changed": "settings.agents.webhooks.event.databaseChanged",
};

/** A webhook event in words; its id is what a receiver sees, so the picker shows it too. */
const eventLabel = (type: string): string => (isWorkspaceEventType(type) ? t(EVENT_LABEL[type]) : type);

export function AgentSettings() {
  const toast = useToast();
  const nav = useNavigate();
  const { isReady, workspace, canManage, reload } = useSettingsScope();

  const [instructions, setInstructions] = useState("");
  const [savingInstructions, setSavingInstructions] = useState(false);

  const [folders, setFolders] = useState<Folder[]>([]);

  const [hooks, setHooks] = useState<WebhookInfo[] | null>(null);
  const [eventTypes, setEventTypes] = useState<readonly string[]>([]);
  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState<string[]>([]);
  const [hookFolder, setHookFolder] = useState(WHOLE_WORKSPACE);
  const [savingHook, setSavingHook] = useState(false);
  const [newSecret, setNewSecret] = useState<{ url: string; secret: string } | null>(null);

  const load = useCallback(async () => {
    // Webhooks are admin-only on the server; a member has no section, and asking would only be refused (and ledgered).
    if (!canManage) {
      setHooks(null);
      return;
    }
    // Folders name a webhook's scope; nothing else on this page needs them.
    setFolders((await Folders.list()).folders);
    try {
      const w = await Webhooks.list();
      setHooks(w.webhooks);
      setEventTypes(w.event_types);
    } catch {
      setHooks(null);
    }
  }, [canManage]);

  useEffect(() => {
    if (!workspace) return;
    setInstructions(workspace.agent_instructions ?? "");
    void load().catch(() => toast({ body: t("settings.agents.loadFailed"), type: "error" }));
  }, [workspace?.workspace_id, load]);

  const folderName = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.folder_id, f.title || t("common.untitledFolder")]));
    return (id: string | null) => (id ? (byId.get(id) ?? id) : t("settings.agents.wholeWorkspace"));
  }, [folders]);

  if (!isReady || !workspace) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label={t("common.loading")} />
        </VStack>
      </PageColumn>
    );
  }

  async function saveInstructions() {
    if (!workspace) return;
    setSavingInstructions(true);
    try {
      await Workspaces.update(workspace.workspace_id, { agent_instructions: instructions });
      await reload();
      toast({ body: t("settings.agents.instructions.saved"), type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.agents.instructions.saveFailed")), type: "error" });
    } finally {
      setSavingInstructions(false);
    }
  }

  async function addHook() {
    setSavingHook(true);
    try {
      const { webhook, secret } = await Webhooks.create({ url: hookUrl.trim(), events: hookEvents, folder_id: hookFolder || null });
      setNewSecret({ url: webhook.url, secret });
      setHookUrl("");
      setHookEvents([]);
      setHookFolder(WHOLE_WORKSPACE);
      await load();
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.agents.webhooks.addFailed")), type: "error" });
    } finally {
      setSavingHook(false);
    }
  }

  async function setHookActive(h: WebhookInfo, active: boolean) {
    try {
      const { webhook } = await Webhooks.update(h.webhook_id, { active });
      setHooks((prev) => prev?.map((x) => (x.webhook_id === h.webhook_id ? webhook : x)) ?? prev);
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.agents.webhooks.changeFailed")), type: "error" });
    }
  }

  async function removeHook(h: WebhookInfo) {
    try {
      await Webhooks.remove(h.webhook_id);
      setHooks((prev) => prev?.filter((x) => x.webhook_id !== h.webhook_id) ?? prev);
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.agents.webhooks.removeFailed")), type: "error" });
    }
  }

  const folderOptions = [
    { value: WHOLE_WORKSPACE, label: t("settings.agents.wholeWorkspace") },
    ...folders.map((f) => ({ value: f.folder_id, label: f.title || t("common.untitledFolder") })),
  ];

  const hookColumns = [
    {
      key: "url",
      header: t("settings.agents.webhooks.url"),
      width: proportional(2),
      renderCell: (h: WebhookInfo) => (
        <VStack gap={0}>
          <span style={{ wordBreak: "break-all" }}>{h.url}</span>
          <Text type="supporting" color="secondary">
            {h.events.length === 0 ? t("settings.agents.webhooks.everyEvent") : listOf(h.events.map(eventLabel))} · {folderName(h.folder_id)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "state",
      header: t("settings.agents.webhooks.deliveries"),
      width: proportional(1),
      renderCell: (h: WebhookInfo) => (
        <HStack gap={2} vAlign="center">
          {!h.active && <Badge variant="neutral" label={t("settings.agents.webhooks.paused")} />}
          {h.failures > 0 && <Badge variant="red" label={t("settings.agents.webhooks.failing", { count: h.failures })} />}
          <Text type="supporting" color="secondary" as="span">
            {h.last_delivery_at ? (
              <span title={absoluteTime(h.last_delivery_at)}>
                {h.last_status !== null
                  ? t("settings.agents.webhooks.lastStatus", { time: relativeTime(h.last_delivery_at), status: h.last_status })
                  : t("settings.agents.webhooks.lastUnreachable", { time: relativeTime(h.last_delivery_at) })}
              </span>
            ) : (
              t("settings.agents.webhooks.nothingDelivered")
            )}
          </Text>
        </HStack>
      ),
    },
    {
      key: "actions",
      header: "",
      width: pixel(170),
      renderCell: (h: WebhookInfo) => (
        <HStack gap={1} justify="end">
          <Button label={h.active ? t("settings.agents.webhooks.pause") : t("settings.agents.webhooks.resume")} variant="ghost" size="sm" onClick={() => void setHookActive(h, !h.active)} />
          <Button label={t("common.remove")} variant="ghost" size="sm" onClick={() => void removeHook(h)} />
        </HStack>
      ),
    },
  ];

  return (
    <PageColumn width={920}>
      <VStack gap={6}>
        <VStack gap={2}>
          <SettingsTitle>{t("settings.layout.agents")}</SettingsTitle>
          {/* Whose page this is: the workspace's, beside the personal Your AI agents. */}
          <Text color="secondary">
            {tRich("settings.agents.intro", {
              link: (chunks) => <Link onClick={() => nav("/settings/agents")}>{chunks}</Link>,
            })}
          </Text>
        </VStack>
        <VStack gap={3}>
          <Heading level={2}>{t("settings.agents.instructions.heading")}</Heading>
          <Text color="secondary">{t("settings.agents.instructions.intro")}</Text>
          <TextArea
            label={t("settings.agents.instructions.label")}
            isLabelHidden
            rows={8}
            value={instructions}
            onChange={setInstructions}
            isReadOnly={!canManage}
            placeholder={t("settings.agents.instructions.placeholder")}
          />
          {canManage && (
            <HStack justify="end">
              <Button label={t("settings.agents.instructions.save")} variant="primary" onClick={() => void saveInstructions()} isLoading={savingInstructions} />
            </HStack>
          )}
        </VStack>

        <Divider />

        <VStack gap={3}>
          <Heading level={2}>{t("settings.agents.changes.heading")}</Heading>
          <Text color="secondary">{t("settings.agents.changes.wait")}</Text>
          <Text color="secondary">
            {tRich("settings.agents.changes.direct", {
              // The menu item and the page by the names they carry where they are.
              menuItem: t("library.state.makeAuto"),
              page: t("common.reviewAiEdits"),
              strong: (chunks) => <strong>{chunks}</strong>,
              link: (chunks) => <Link onClick={() => nav("/review")}>{chunks}</Link>,
            })}
          </Text>
        </VStack>

        {hooks !== null && (
          <>
            <Divider />
            <VStack gap={3}>
              <Heading level={2}>{t("settings.agents.webhooks.heading")}</Heading>
              <Text color="secondary">{t("settings.agents.webhooks.about")}</Text>
              {newSecret && (
                <VStack gap={2}>
                  <Banner
                    status="warning"
                    title={t("settings.agents.webhooks.copySecret", { url: newSecret.url })}
                    description={t("settings.agents.webhooks.shownOnce")}
                  />
                  <CodeBlock code={newSecret.secret} title={t("settings.agents.webhooks.secret")} width="100%" isWrapped hasCopyButton size="sm" />
                  <HStack justify="end">
                    <Button label={t("settings.agents.webhooks.copiedIt")} variant="ghost" size="sm" onClick={() => setNewSecret(null)} />
                  </HStack>
                </VStack>
              )}
              {hooks.length === 0 ? (
                <Text type="supporting" color="secondary">{t("settings.agents.webhooks.none")}</Text>
              ) : (
                <Table data={hooks} columns={hookColumns} dividers="rows" density="compact" />
              )}
              <VStack gap={2}>
                <Text type="supporting" color="secondary">{t("settings.agents.webhooks.addHeading")}</Text>
                {/* One size and a set width each, so the labels and controls line up on one baseline. */}
                <HStack gap={2} vAlign="end" wrap="wrap">
                  <TextInput label={t("settings.agents.webhooks.url")} size="sm" width={300} value={hookUrl} onChange={setHookUrl} placeholder="https://example.com/hooks/stuga" />
                  <MultiSelector
                    label={t("settings.agents.webhooks.events")}
                    size="sm"
                    width={200}
                    placeholder={t("settings.agents.webhooks.allEvents")}
                    options={eventTypes.map((type) => ({ value: type, label: eventLabel(type), description: type }))}
                    value={hookEvents}
                    onChange={(v: string[]) => setHookEvents(v)}
                  />
                  <Selector label={t("settings.agents.webhooks.where")} size="sm" width={200} value={hookFolder} onChange={setHookFolder} options={folderOptions} />
                  <Button label={t("settings.agents.webhooks.add")} variant="secondary" size="sm" onClick={() => void addHook()} isDisabled={!hookUrl.trim()} isLoading={savingHook} />
                </HStack>
              </VStack>
              {/* What a receiving app's developer needs; nobody else has to read it. */}
              <Collapsible trigger={t("common.advanced")} defaultIsOpen={false}>
                <Text type="supporting" color="secondary">
                  {tRich("settings.agents.webhooks.signature", {
                    header: <code>X-Stuga-Signature</code>, // i18n-exempt: an HTTP header name
                  })}
                </Text>
              </Collapsible>
            </VStack>
          </>
        )}
      </VStack>
    </PageColumn>
  );
}
