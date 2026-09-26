/**
 * The page a signed-in member of no workspace lands on: create the first one,
 * empty, from a sample or from a workspace archive.
 * A node administrator on a node with no AI set up is then shown the three
 * optional ways AI comes in, each set up in place: their own agent, which
 * brings its own model and needs no key here, the built-in AI on an API key,
 * and search by meaning.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav } from "@astryxdesign/core/TopNav";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Item } from "@astryxdesign/core/Item";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Selector } from "@astryxdesign/core/Selector";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Banner } from "@astryxdesign/core/Banner";
import { ArrowRight, LogOut, PanelsTopLeft, Plug, Search, Sparkles } from "lucide-react";
import { Me, NodeSettings, Workspaces, type CreatedWorkspace, type NodeAiSettings } from "../api";
import { AgentClients } from "../agents/ConnectAgent";
import { ConnectForm, type Connected } from "./settings/node/ConnectForm";
import { HALF_COPY, endpointLabel, presetsFor } from "./settings/node/ai-form";
import { invalidateModelOptions } from "../state/model-options";
import { setActiveWorkspace } from "../lib/session/workspace-pointer";
import { ARCHIVE_WORK_MAX_MS, DEFAULT_DOC_ACCESS, type DocAccessMode } from "@stuga/protocol/domain/workspaces";
import { WORKSPACE_ACCESS_OPTIONS, WORKSPACE_ACCESS_HELP } from "../shell/workspace-access";
import {
  ARCHIVE_NAME_PLACEHOLDER,
  ImportMayFinish,
  StartWith,
  createWorkspaceFrom,
  landingPath,
  useBannerInView,
  useNewWorkspace,
  useWorkspaceSamples,
} from "../shell/StartWith";
import { logout } from "../lib/session/tokens";
import { takeWorkspaceReturn } from "../lib/session/return-path";
import { Brand, nodeName } from "../shell/Brand";
import { errorMessage } from "../lib/http/client";

/** How often the page looks for a workspace whose import it stopped waiting for. */
export const IMPORT_CHECK_MS = 10_000;
/**
 * How long after asking for an import the page stops looking: by then the node has finished it or
 * stopped it and deleted its workspace, with time to spare for the list to show it.
 */
export const IMPORT_GIVE_UP_MS = ARCHIVE_WORK_MAX_MS + 5 * 60_000;

/** The node's AI settings when this person could set its AI up first, else null. */
async function aiToConnect(): Promise<NodeAiSettings | null> {
  try {
    if (!(await Me.whoami()).node_admin) return null;
    const ai = await NodeSettings.ai();
    return ai.chat.endpoints.length === 0 && !ai.embed.model ? ai : null;
  } catch {
    return null;
  }
}

export function WorkspaceOnboarding() {
  const nav = useNavigate();
  /** Set once the workspace exists and AI is the step left. */
  const [ai, setAi] = useState<NodeAiSettings | null>(null);
  const { name, setName, start, setStart, ready, nameOptional } = useNewWorkspace();
  const samples = useWorkspaceSamples(true);
  const [access, setAccess] = useState<DocAccessMode>(DEFAULT_DOC_ACCESS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useBannerInView(error);
  /** Where the new workspace opens once the steps here are done. */
  const [landing, setLanding] = useState<string | null>(null);
  /**
   * When an import this page stopped waiting for was asked for; it may still finish. Meanwhile no
   * other is asked for: the node refuses a second, and one asked for once it is done is a copy.
   */
  const [importing, setImporting] = useState<number | null>(null);
  const importingRef = useBannerInView(importing);

  // An imported or sample workspace opens at the document it starts with; else wherever the person was headed.
  const enter = (to: string | null) => {
    const back = takeWorkspaceReturn();
    nav(to ?? back, { replace: true });
  };

  async function opened(workspace: CreatedWorkspace) {
    setActiveWorkspace(workspace.workspace_id);
    const to = workspace.start_doc_id ? landingPath(workspace) : null;
    setLanding(to);
    // Asked only now: a person with no workspace yet cannot read the node's settings.
    const next = await aiToConnect();
    if (next) setAi(next);
    else enter(to);
  }

  async function createWorkspace() {
    if (busy || !ready || importing !== null) return;
    setBusy(true);
    setError(null);
    const asked = Date.now();
    try {
      await opened(await createWorkspaceFrom(start, name.trim(), access));
    } catch (err) {
      if (err instanceof ImportMayFinish) setImporting(asked);
      else setError(errorMessage(err, "Couldn't create the workspace."));
    } finally {
      setBusy(false);
    }
  }

  // Nothing else here lists workspaces, so the page looks for the one the import makes, until none can come.
  useEffect(() => {
    if (importing === null) return;
    let alive = true;
    const stop = () => {
      alive = false;
      clearInterval(timer);
      setImporting(null);
    };
    const timer = setInterval(() => {
      Workspaces.list()
        .then(({ workspaces }) => {
          if (!alive) return;
          if (workspaces[0]) {
            stop();
            return opened(workspaces[0]);
          }
          if (Date.now() - importing < IMPORT_GIVE_UP_MS) return;
          stop();
          setError("The import didn’t finish. Try again.");
        })
        .catch(() => {});
    }, IMPORT_CHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `opened` reads nothing that changes while the page waits
  }, [importing]);

  return (
    <AppShell
      contentPadding={0}
      topNav={
        <TopNav
          label="Workspace setup"
          startContent={
            <HStack gap={2} vAlign="center">
              <Brand />
              <Heading level={1}>{nodeName()}</Heading>
            </HStack>
          }
          endContent={<IconButton label="Sign out" variant="ghost" icon={<LogOut size={17} />} onClick={logout} />}
        />
      }
    >
      {/* The AI step holds Your own AI's client tabs and commands, so it takes that settings page's width. */}
      <Layout contentWidth={ai ? 760 : 560} padding={6}>
        <LayoutContent>
          {ai ? (
            <AiChoices
              settings={ai}
              onSaved={setAi}
              onStart={() => enter(landing)}
            />
          ) : (
            <VStack gap={6}>
              <VStack gap={2}>
                <Heading level={1}>Create your workspace</Heading>
                <Text color="secondary">A place for your documents. Start on your own and invite others when you’re ready.</Text>
              </VStack>
              {importing !== null && (
                <Banner ref={importingRef} status="info" title="The import may still finish" description="This page opens the workspace when it does." />
              )}
              {error && <Banner ref={errorRef} status="error" title="Workspace creation failed" description={error} />}
              <VStack gap={4}>
                <TextInput
                  label="Workspace name"
                  placeholder={nameOptional ? ARCHIVE_NAME_PLACEHOLDER : "For example, My projects"}
                  value={name}
                  onChange={setName}
                  onEnter={createWorkspace}
                  isRequired={!nameOptional}
                  hasAutoFocus
                  isDisabled={busy}
                />
                {/* This choice is stamped on new items; it does not change existing sharing. */}
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
              <HStack justify="end">
                <Button
                  label="Create workspace"
                  variant="primary"
                  icon={<PanelsTopLeft size={16} />}
                  onClick={createWorkspace}
                  isDisabled={busy || !ready || importing !== null}
                  isLoading={busy}
                />
              </HStack>
            </VStack>
          )}
        </LayoutContent>
      </Layout>
    </AppShell>
  );
}

type Way = "agent" | "chat" | "search";

/** The three ways AI comes in, none required; the button at the end enters the workspace. */
function AiChoices({
  settings,
  onSaved,
  onStart,
}: {
  settings: NodeAiSettings;
  onSaved: (settings: NodeAiSettings) => void;
  onStart: () => void;
}) {
  const [open, setOpen] = useState<Record<Way, boolean>>({ agent: false, chat: false, search: false });
  const show = (way: Way, on: boolean) => setOpen((o) => ({ ...o, [way]: on }));

  const presets = presetsFor(settings.provider_base_urls);
  const provider = settings.chat.endpoints[0];
  const chatDone = provider
    ? `${endpointLabel(presets, provider.provider, provider.base_url)} · ${provider.models.map((m) => m.name).join(", ")}`
    : null;
  const searchDone = settings.embed.model
    ? `${endpointLabel(presets, settings.embed.provider, settings.embed.base_url)} · ${settings.embed.model}`
    : null;

  // The row itself now says what was set up, so the form's notice is not repeated.
  function connected(way: Way, { settings: next }: Connected) {
    onSaved(next);
    if (way === "chat") invalidateModelOptions();
    show(way, false);
  }

  return (
    <VStack gap={6}>
      <VStack gap={2}>
        <Heading level={1}>Your workspace is ready</Heading>
        <Text color="secondary">Start writing now. AI is optional: add it here or later.</Text>
      </VStack>
      <Card>
        <VStack gap={4}>
          <Choice
            icon={<Plug size={18} />}
            title="Your own AI"
            about="Claude, Codex and others, on your own subscription. Just for you: each member connects their own."
            isOpen={open.agent}
            onOpen={() => show("agent", true)}
          >
            {/* Nothing on this page lists keys, so a new one has nothing to reload. */}
            <AgentClients onKeyCreated={() => {}} />
            <HStack>
              <Button label="Done" variant="secondary" size="sm" onClick={() => show("agent", false)} />
            </HStack>
          </Choice>
          <Divider />
          <Choice
            icon={<Sparkles size={18} />}
            {...HALF_COPY.chat}
            done={chatDone}
            isOpen={open.chat}
            onOpen={() => show("chat", true)}
          >
            <ConnectForm half="chat" settings={settings} onConnected={(r) => connected("chat", r)} onCancel={() => show("chat", false)} />
          </Choice>
          <Divider />
          <Choice
            icon={<Search size={18} />}
            {...HALF_COPY.search}
            done={searchDone}
            isOpen={open.search}
            onOpen={() => show("search", true)}
          >
            <ConnectForm half="search" settings={settings} onConnected={(r) => connected("search", r)} onCancel={() => show("search", false)} />
          </Choice>
        </VStack>
      </Card>
      <HStack justify="end">
        <Button label="Start using Stuga" variant="primary" endContent={<ArrowRight size={16} />} onClick={onStart} />
      </HStack>
    </VStack>
  );
}

/** One way in: what it is, its setup in place once opened, and what was set up once it is. */
function Choice({
  icon,
  title,
  about,
  done,
  isOpen,
  onOpen,
  children,
}: {
  icon: ReactNode;
  title: string;
  about: string;
  /** What is set up, which then stands in for `about`; the page cannot tell for an outside agent. */
  done?: string | null;
  isOpen: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  const setUp = !!done;
  return (
    <VStack gap={3}>
      <Item
        startContent={icon}
        label={<Text weight="semibold">{title}</Text>}
        // Wraps rather than truncates: the end of a line ("Just for you…") is often the point.
        description={done ?? about}
        descriptionLines={4}
        align="start"
        endContent={
          setUp ? (
            <HStack gap={1} vAlign="center">
              {/* The word beside it says the same, so the dot is not read out twice. */}
              <StatusDot variant="success" label="On" aria-hidden="true" />
              <Text type="supporting">On</Text>
            </HStack>
          ) : (
            !isOpen && <Button label="Set up" variant="secondary" size="sm" onClick={onOpen} />
          )
        }
      />
      {isOpen && !setUp && (
        // Inset like the row's own content, so the setup lines up under its icon and button.
        <VStack gap={3} style={{ paddingInline: "var(--spacing-2)", paddingBlockEnd: "var(--spacing-2)" }}>
          {children}
        </VStack>
      )}
    </VStack>
  );
}
