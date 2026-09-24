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
import { useToast } from "@astryxdesign/core/Toast";
import { useSettingsScope } from "./SettingsLayout";
import { PageColumn } from "../../ui/PageColumn";
import { relativeTime, absoluteTime } from "../../lib/format";
import { Folders, Webhooks, Workspaces, type Folder, type WebhookInfo } from "../../api";
import { errorMessage } from "../../lib/http/client";

const WHOLE_WORKSPACE = "";

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
    // Folders name a webhook's scope; nothing else on this page needs them.
    setFolders((await Folders.list()).folders);
    // Webhooks are admin-only on the server; a member simply has no section.
    try {
      const w = await Webhooks.list();
      setHooks(w.webhooks);
      setEventTypes(w.event_types);
    } catch {
      setHooks(null);
    }
  }, []);

  useEffect(() => {
    if (!workspace) return;
    setInstructions(workspace.agent_instructions ?? "");
    void load().catch(() => toast({ body: "Couldn't load the agent settings.", type: "error" }));
  }, [workspace?.workspace_id, load]);

  const folderName = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.folder_id, f.title || "Untitled folder"]));
    return (id: string | null) => (id ? (byId.get(id) ?? id) : "Whole workspace");
  }, [folders]);

  if (!isReady || !workspace) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label="Loading…" />
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
      toast({
        body: "Instructions saved. Agents use them from their next turn.",
        type: "info",
      });
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't save the instructions."), type: "error" });
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
      toast({ body: errorMessage(e, "Couldn't add the webhook."), type: "error" });
    } finally {
      setSavingHook(false);
    }
  }

  async function setHookActive(h: WebhookInfo, active: boolean) {
    try {
      const { webhook } = await Webhooks.update(h.webhook_id, { active });
      setHooks((prev) => prev?.map((x) => (x.webhook_id === h.webhook_id ? webhook : x)) ?? prev);
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't change the webhook."), type: "error" });
    }
  }

  async function removeHook(h: WebhookInfo) {
    try {
      await Webhooks.remove(h.webhook_id);
      setHooks((prev) => prev?.filter((x) => x.webhook_id !== h.webhook_id) ?? prev);
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't remove the webhook."), type: "error" });
    }
  }

  const folderOptions = [
    { value: WHOLE_WORKSPACE, label: "Whole workspace" },
    ...folders.map((f) => ({ value: f.folder_id, label: f.title || "Untitled folder" })),
  ];

  const hookColumns = [
    {
      key: "url",
      header: "URL",
      width: proportional(2),
      renderCell: (h: WebhookInfo) => (
        <VStack gap={0}>
          <span style={{ wordBreak: "break-all" }}>{h.url}</span>
          <Text type="supporting" color="secondary">
            {h.events.length === 0 ? "every event" : h.events.join(", ")} · {folderName(h.folder_id)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "state",
      header: "Deliveries",
      width: proportional(1),
      renderCell: (h: WebhookInfo) => (
        <HStack gap={2} vAlign="center">
          {!h.active && <Badge variant="neutral" label="Paused" />}
          {h.failures > 0 && <Badge variant="red" label={`${h.failures} failing`} />}
          <Text type="supporting" color="secondary" as="span">
            {h.last_delivery_at ? (
              <span title={absoluteTime(h.last_delivery_at)}>
                last {relativeTime(h.last_delivery_at)}
                {h.last_status !== null ? ` · HTTP ${h.last_status}` : " · unreachable"}
              </span>
            ) : (
              "nothing delivered yet"
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
          <Button label={h.active ? "Pause" : "Resume"} variant="ghost" size="sm" onClick={() => void setHookActive(h, !h.active)} />
          <Button label="Remove" variant="ghost" size="sm" onClick={() => void removeHook(h)} />
        </HStack>
      ),
    },
  ];

  return (
    <PageColumn width={920}>
      <VStack gap={6}>
        <VStack gap={3}>
          <Heading level={2}>Instructions for agents</Heading>
          <Text color="secondary">
            Shared defaults for every agent. Add item-specific instructions from its ⋯ menu.
          </Text>
          <TextArea
            label="Instructions"
            isLabelHidden
            rows={8}
            value={instructions}
            onChange={setInstructions}
            isReadOnly={!canManage}
            placeholder={"Example:\n- Daily notes go in Journal/, one document per day, appended to.\n- Never edit anything under Contracts/.\n- Tasks live in the Tasks database; add rows, don't rewrite them."}
          />
          {canManage && (
            <HStack justify="end">
              <Button label="Save instructions" variant="primary" onClick={() => void saveInstructions()} isLoading={savingInstructions} />
            </HStack>
          )}
        </VStack>

        <Divider />

        <VStack gap={3}>
          <Heading level={2}>Agent changes</Heading>
          <Text color="secondary">
            Agent edits wait until someone accepts or rejects them.
          </Text>
          <Text color="secondary">
            To auto-apply edits for an item, choose <strong>Let agents apply changes at once</strong> from its ⋯ menu.
            Check the agent’s record in <Link onClick={() => nav("/review")}>Review AI edits</Link> first.
          </Text>
        </VStack>

        {hooks !== null && (
          <>
            <Divider />
            <VStack gap={3}>
              <Heading level={2}>Webhooks</Heading>
              <Text color="secondary">
                Send workspace events to a URL. Each request includes an HMAC-SHA256 signature in{" "}
                <code>X-Stuga-Signature</code>.
              </Text>
              {newSecret && (
                <VStack gap={2}>
                  <Banner
                    status="warning"
                    title={`Copy the secret for ${newSecret.url}`}
                    description="Shown once. Use it to verify X-Stuga-Signature against the raw body."
                  />
                  <CodeBlock code={newSecret.secret} title="Webhook secret" width="100%" isWrapped hasCopyButton size="sm" />
                  <HStack justify="end">
                    <Button label="I've copied it" variant="ghost" size="sm" onClick={() => setNewSecret(null)} />
                  </HStack>
                </VStack>
              )}
              {hooks.length === 0 ? (
                <Text type="supporting" color="secondary">No webhooks yet.</Text>
              ) : (
                <Table data={hooks} columns={hookColumns} dividers="rows" density="compact" />
              )}
              <VStack gap={2}>
                <Text type="supporting" color="secondary">Add a webhook</Text>
                <HStack gap={2} vAlign="end" style={{ flexWrap: "wrap", rowGap: 8 }}>
                  <TextInput label="URL" size="sm" width={340} value={hookUrl} onChange={setHookUrl} placeholder="https://example.com/hooks/stuga" />
                  <MultiSelector
                    label="Events (empty = all)"
                    options={eventTypes.map((t) => ({ value: t, label: t }))}
                    value={hookEvents}
                    onChange={(v: string[]) => setHookEvents(v)}
                  />
                  <Selector label="Where" size="sm" width={200} value={hookFolder} onChange={setHookFolder} options={folderOptions} />
                  <Button label="Add webhook" variant="secondary" size="sm" onClick={() => void addHook()} isDisabled={!hookUrl.trim()} isLoading={savingHook} />
                </HStack>
              </VStack>
            </VStack>
          </>
        )}
      </VStack>
    </PageColumn>
  );
}
