/**
 * Settings → Your own AI: the card for connecting a client, one tab per client. Every
 * config comes from the node's AgentSetup, so the card waits for it. A key is
 * pinned to the workspace it is minted in, which is why that workspace is named.
 */
import { useCallback, useEffect, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Plug } from "lucide-react";
import type { AgentSetup } from "@stuga/protocol/api/agent-setup";
import { Agents } from "../api";
import { LoadFailed } from "../ui/LoadFailed";
import { TAB_LABEL, clientConfigs, clientTabs, type ClientTab } from "./client-configs";
import { useMintKey } from "./MintKey";
import { ClaudeCodeTab } from "./tabs/ClaudeCodeTab";
import { ClaudeConnectorTab } from "./tabs/ClaudeConnectorTab";
import { ClaudeDesktopTab } from "./tabs/ClaudeDesktopTab";
import { InstallerTab } from "./tabs/InstallerTab";
import { DshTab } from "./tabs/DshTab";
import { OtherClientsTab } from "./tabs/OtherClientsTab";

interface AgentClientsProps {
  /** The workspace a new key is pinned to; null while the page's workspace list is unknown. */
  workspaceName: string | null;
  /** A key was minted, so a list of keys can reload. */
  onKeyCreated: () => void;
}

export function ConnectAgent({ workspaceName, onKeyCreated }: AgentClientsProps) {
  return (
    <Card>
      <VStack gap={3} style={{ padding: 20 }}>
        <Heading level={2}>Connect an agent</Heading>
        <Text color="secondary">
          Agents act with your access, and their changes appear in version history. They start in{" "}
          {workspaceName ? <strong>{workspaceName}</strong> : "this workspace"} but can use your other workspaces.
        </Text>
        <AgentClients workspaceName={workspaceName} onKeyCreated={onKeyCreated} />
      </VStack>
    </Card>
  );
}

/** A tab per client with its setup for this node, also offered at first run. */
export function AgentClients({ workspaceName, onKeyCreated }: AgentClientsProps) {
  const [setup, setSetup] = useState<AgentSetup | null>(null);
  const [failed, setFailed] = useState(false);
  // The tab the user picked; until then the node's answer decides the first tab.
  const [tab, setTab] = useState<ClientTab | null>(null);
  const mint = useMintKey(onKeyCreated);

  const load = useCallback(() => {
    setFailed(false);
    Agents.setup()
      .then(setSetup)
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  if (failed) return <LoadFailed isCompact icon={<Plug size={22} />} title="Couldn’t load connection options" onRetry={load} />;
  if (setup === null) {
    return (
      <VStack gap={2} hAlign="center" style={{ padding: "1.5rem 0" }}>
        <Spinner label="Loading…" />
      </VStack>
    );
  }
  return <ClientTabs setup={setup} tab={tab} onTab={setTab} workspaceName={workspaceName} mint={mint} onKeyCreated={onKeyCreated} />;
}

function ClientTabs({
  setup,
  tab,
  onTab,
  workspaceName,
  mint,
  onKeyCreated,
}: {
  setup: AgentSetup;
  tab: ClientTab | null;
  onTab: (tab: ClientTab) => void;
  workspaceName: string | null;
  mint: ReturnType<typeof useMintKey>;
  onKeyCreated: () => void;
}) {
  const tabs = clientTabs(setup);
  const active = tab !== null && tabs.includes(tab) ? tab : tabs[0];
  const configs = clientConfigs(setup, mint.minted?.token ?? null);
  return (
    <>
      <TabList value={active} onChange={(v) => onTab(v as ClientTab)} layout="fill" hasDivider>
        {tabs.map((t) => (
          <Tab key={t} value={t} label={TAB_LABEL[t]} />
        ))}
      </TabList>
      {active === "claude" && <ClaudeConnectorTab mcpUrl={configs.mcpUrl} />}
      {active === "claude-desktop" && (
        <ClaudeDesktopTab
          canBundle={setup.bundle.available}
          bundleFilename={configs.bundleFilename}
          serverKey={configs.serverKey}
          desktopJson={configs.desktopJson}
          mint={mint}
          onKeyCreated={onKeyCreated}
        />
      )}
      {active === "claude-code" && (
        <ClaudeCodeTab cliCommand={configs.cliCommand} serverKey={configs.serverKey} needsKey={configs.cliNeedsKey} mint={mint} />
      )}
      {active === "codex" && <InstallerTab host="Codex" commands={configs.installers.codex} />}
      {active === "antigravity" && (
        <InstallerTab
          host="Antigravity"
          commands={configs.installers.antigravity}
          signIn="Installs Stuga. Antigravity has no command that starts its sign-in, so authenticate it under Settings → Customizations → Installed MCP Servers."
        />
      )}
      {active === "dsh" && <DshTab dshEnv={configs.dshEnv} mint={mint} />}
      {active === "other" && <OtherClientsTab httpJson={configs.httpJson} workspaceName={workspaceName} mint={mint} />}
    </>
  );
}
