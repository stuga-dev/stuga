/**
 * Settings → Your AI agents: connecting an outside agent, and every agent the caller
 * has connected. Personal, so it sits with the preferences; the node's own AI is
 * under This node → AI providers.
 */
import { useEffect, useState } from "react";
import { ConnectAgent } from "../../agents/ConnectAgent";
import { ConnectedAgents } from "../../agents/ConnectedAgents";
import { PageColumn } from "../../ui/PageColumn";
import { SettingsTitle } from "./SettingsTitle";
import { t } from "../../i18n/i18n";
import { VStack } from "@astryxdesign/core/VStack";
import { Workspaces, type WorkspaceInfo } from "../../api";
import { getActiveWorkspace } from "../../lib/session/workspace-pointer";
import { useSettingsScope } from "./SettingsLayout";

export function YourAiAgents() {
  // Only names the workspace a key is pinned to; a failure costs the name, not the page.
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  /** Bumped when the connect card mints a key, so the list refetches. */
  const [keysChanged, setKeysChanged] = useState(0);

  useEffect(() => {
    Workspaces.list()
      .then(({ workspaces }) => setWorkspaces(workspaces))
      .catch(() => {});
  }, []);

  // The settings rail's switcher picks the workspace a new key is pinned to.
  const activeWorkspaceId = getActiveWorkspace();
  const { isNodeAdmin } = useSettingsScope();

  return (
    <PageColumn>
      <VStack gap={5}>
        <SettingsTitle>{t("common.yourAiAgents")}</SettingsTitle>
        <ConnectAgent onKeyCreated={() => setKeysChanged((n) => n + 1)} isNodeAdmin={isNodeAdmin} />
        <ConnectedAgents activeWorkspaceId={activeWorkspaceId} workspaces={workspaces} reloadSignal={keysChanged} />
      </VStack>
    </PageColumn>
  );
}
