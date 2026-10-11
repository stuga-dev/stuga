/**
 * Settings → Your AI agents: the card for connecting a client. A grouped, searchable
 * picker chooses the client and its setup shows below, so the card stays one
 * client tall however many there are. Every config comes from the node's
 * AgentSetup, so the card waits for it. A key is pinned to the workspace it is
 * minted in, which is why that workspace is named.
 */
import { useCallback, useEffect, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Selector, type SelectorProps } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Link } from "@astryxdesign/core/Link";
import { Plug } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { AgentSetup } from "@stuga/protocol/api/agent-setup";
import { Agents } from "../api";
import { LoadFailed } from "../ui/LoadFailed";
import { t } from "../i18n/i18n";
import { tRich } from "../i18n/rich";
import { CLIENT_GROUPS, clientConfigs, clientTabs, type ClientTab, tabLabel } from "./client-configs";
import { useMintKey } from "./MintKey";
import { ClaudeCodeTab } from "./tabs/ClaudeCodeTab";
import { ClaudeConnectorTab } from "./tabs/ClaudeConnectorTab";
import { ClaudeDesktopTab } from "./tabs/ClaudeDesktopTab";
import { InstallerTab } from "./tabs/InstallerTab";
import { DshTab } from "./tabs/DshTab";
import { PiTab } from "./tabs/PiTab";
import { LinkTab } from "./tabs/LinkTab";
import { OtherClientsTab } from "./tabs/OtherClientsTab";

interface AgentClientsProps {
  /** A key was minted, so a list of keys can reload. */
  onKeyCreated: () => void;
  /** Whether the viewer can turn remote access on, so the page can take them there. */
  isNodeAdmin?: boolean;
}

export function ConnectAgent({ onKeyCreated, isNodeAdmin }: AgentClientsProps) {
  return (
    <Card>
      <VStack gap={3} style={{ padding: 20 }}>
        <Heading level={2}>{t("agents.connect.title")}</Heading>
        <Text color="secondary">{t("agents.connect.intro")}</Text>
        <AgentClients onKeyCreated={onKeyCreated} isNodeAdmin={isNodeAdmin} />
      </VStack>
    </Card>
  );
}

/** Remote access, reached in-app: a full page load would drop the in-memory session. */
function RemoteAccessLink({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  return <Link onClick={() => nav("/settings/node/remote")}>{children}</Link>;
}

/** Which client this browser last picked: a per-viewer convenience, so storage may be missing or refuse. */
const PICKED_KEY = "stuga:agents:client";

function readPicked(): ClientTab | null {
  try {
    return (localStorage.getItem(PICKED_KEY) as ClientTab | null) ?? null;
  } catch {
    return null;
  }
}

function writePicked(tab: ClientTab): void {
  try {
    localStorage.setItem(PICKED_KEY, tab);
  } catch {
    // Remembering the pick is a convenience; the picker works without it.
  }
}

/** A picker of clients with the chosen one's setup for this node, also offered at first run. */
export function AgentClients({ onKeyCreated, isNodeAdmin = false }: AgentClientsProps) {
  const [setup, setSetup] = useState<AgentSetup | null>(null);
  const [failed, setFailed] = useState(false);
  // The client the user picked, here or last time; until then the node's answer decides the first one.
  const [tab, setTab] = useState<ClientTab | null>(readPicked);
  const pick = (next: ClientTab) => {
    setTab(next);
    writePicked(next);
  };
  const mint = useMintKey(onKeyCreated);

  const load = useCallback(() => {
    setFailed(false);
    Agents.setup()
      .then(setSetup)
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  if (failed) return <LoadFailed isCompact icon={<Plug size={22} />} title={t("agents.connect.loadFailed")} onRetry={load} />;
  if (setup === null) {
    return (
      <VStack gap={2} hAlign="center" style={{ padding: "1.5rem 0" }}>
        <Spinner label={t("common.loading")} />
      </VStack>
    );
  }
  return <ClientTabs setup={setup} tab={tab} onTab={pick} mint={mint} isNodeAdmin={isNodeAdmin} />;
}

function ClientTabs({
  setup,
  tab,
  onTab,
  mint,
  isNodeAdmin,
}: {
  setup: AgentSetup;
  tab: ClientTab | null;
  onTab: (tab: ClientTab) => void;
  mint: ReturnType<typeof useMintKey>;
  isNodeAdmin: boolean;
}) {
  const tabs = clientTabs(setup);
  const active = tab !== null && tabs.includes(tab) ? tab : tabs[0];
  const configs = clientConfigs(setup, mint.minted?.token ?? null, window.location.origin);
  const options: SelectorProps["options"] = [
    ...CLIENT_GROUPS.map((group) => ({
      type: "section" as const,
      title: t(group.titleKey),
      options: group.clients.filter((c) => tabs.includes(c)).map((c) => ({ value: c, label: tabLabel(c) })),
    })),
    { type: "divider" as const },
    { value: "other", label: tabLabel("other") },
  ];
  return (
    <>
      <Selector
        label={t("agents.connect.appLabel")}
        options={options}
        value={active}
        onChange={(v) => onTab(v as ClientTab)}
        hasSearch
        searchPlaceholder={t("agents.connect.searchApps")}
        width="min(100%, 20rem)"
      />
      {/* Claude on the web dials from its own cloud: say why it is not offered, and where that changes. */}
      {!tabs.includes("claude") && (
        <Text size="sm" color="secondary">
          {isNodeAdmin
            ? tRich("agents.connect.webNeedsPublicAdmin", { link: (chunks) => <RemoteAccessLink>{chunks}</RemoteAccessLink> })
            : t("agents.connect.webNeedsPublic")}
        </Text>
      )}
      {active !== "claude" && (
        <Text size="sm" color="secondary">
          {tRich(configs.address.thisComputerOnly ? "agents.address.thisComputer" : "agents.address.otherDevices", {
            url: configs.address.url,
            code: (chunks) => <code>{chunks}</code>,
          })}
        </Text>
      )}
      {active === "claude" && <ClaudeConnectorTab mcpUrl={configs.hostedMcpUrl} />}
      {active === "claude-desktop" && (
        <ClaudeDesktopTab
          canBundle={setup.bundle.available}
          bundleFilename={configs.bundleFilename}
          serverKey={configs.serverKey}
          desktopJson={configs.desktopJson}
          mint={mint}
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
          afterRun={t("agents.installer.antigravityAfterRun")}
        />
      )}
      {active === "cursor" && <LinkTab host="Cursor" link={configs.links.cursor} mint={mint} />}
      {active === "vscode" && <LinkTab host="VS Code" link={configs.links.vscode} mint={mint} />}
      {active === "kiro" && <LinkTab host="Kiro" link={configs.links.kiro} mint={mint} />}
      {active === "goose" && <LinkTab host="Goose" link={configs.links.goose} mint={mint} />}
      {active === "lmstudio" && <LinkTab host="LM Studio" link={configs.links.lmstudio} mint={mint} />}
      {active === "dsh" && <DshTab dshEnv={configs.dshEnv} mint={mint} />}
      {active === "pi" && <PiTab piUrlEnv={configs.piUrlEnv} piKeyEnv={configs.piKeyEnv} mint={mint} />}
      {active === "other" && <OtherClientsTab httpJson={configs.httpJson} mint={mint} />}
    </>
  );
}
