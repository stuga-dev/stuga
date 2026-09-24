/**
 * The page a signed-in member of no workspace lands on: create the first one.
 * A node administrator on a node with no AI set up is then shown the three
 * optional ways AI comes in, each set up in place: their own agent, which
 * brings its own model and needs no key here, the built-in AI on an API key,
 * and search by meaning.
 */
import { useState, type ReactNode } from "react";
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
import { Me, NodeSettings, Workspaces, type NodeAiSettings } from "../api";
import { AgentClients } from "../agents/ConnectAgent";
import { ConnectForm, type Connected } from "./settings/node/ConnectForm";
import { HALF_COPY, endpointLabel, presetsFor } from "./settings/node/ai-form";
import { invalidateModelOptions } from "../state/model-options";
import { setActiveWorkspace } from "../lib/session/workspace-pointer";
import { DEFAULT_DOC_ACCESS, type DocAccessMode } from "@stuga/protocol/domain/workspaces";
import { WORKSPACE_ACCESS_OPTIONS, WORKSPACE_ACCESS_HELP } from "../shell/workspace-access";
import { logout } from "../lib/session/tokens";
import { takeWorkspaceReturn } from "../lib/session/return-path";
import { Brand, nodeName } from "../shell/Brand";
import { errorMessage } from "../lib/http/client";

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
  const [name, setName] = useState("");
  const [access, setAccess] = useState<DocAccessMode>(DEFAULT_DOC_ACCESS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createWorkspace() {
    const workspaceName = name.trim();
    if (busy || !workspaceName) return;
    setBusy(true);
    setError(null);
    try {
      const workspace = await Workspaces.create(workspaceName, access);
      setActiveWorkspace(workspace.workspace_id);
      // Asked only now: a person with no workspace yet cannot read the node's settings.
      const next = await aiToConnect();
      if (next) setAi(next);
      else nav(takeWorkspaceReturn(), { replace: true });
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the workspace."));
    } finally {
      setBusy(false);
    }
  }

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
              workspaceName={name.trim()}
              onStart={() => nav(takeWorkspaceReturn(), { replace: true })}
            />
          ) : (
            <VStack gap={6}>
              <VStack gap={2}>
                <Heading level={1}>Create your workspace</Heading>
                <Text color="secondary">A place for your documents. Start on your own and invite others when you’re ready.</Text>
              </VStack>
              {error && <Banner status="error" title="Workspace creation failed" description={error} />}
              <VStack gap={4}>
                <TextInput
                  label="Workspace name"
                  placeholder="For example, My projects"
                  value={name}
                  onChange={setName}
                  onEnter={createWorkspace}
                  isRequired
                  hasAutoFocus
                />
                {/* This choice is stamped on new items; it does not change existing sharing. */}
                <Selector
                  label="Who can use new documents?"
                  description={WORKSPACE_ACCESS_HELP}
                  value={access}
                  onChange={(v) => setAccess(v as DocAccessMode)}
                  options={WORKSPACE_ACCESS_OPTIONS}
                />
              </VStack>
              <HStack justify="end">
                <Button
                  label="Create workspace"
                  variant="primary"
                  icon={<PanelsTopLeft size={16} />}
                  onClick={createWorkspace}
                  isDisabled={busy || !name.trim()}
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
  workspaceName,
  onStart,
}: {
  settings: NodeAiSettings;
  onSaved: (settings: NodeAiSettings) => void;
  workspaceName: string;
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
            <AgentClients workspaceName={workspaceName} onKeyCreated={() => {}} />
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
