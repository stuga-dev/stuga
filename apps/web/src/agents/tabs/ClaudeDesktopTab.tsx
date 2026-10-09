import { useState } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Link } from "@astryxdesign/core/Link";
import { useToast } from "@astryxdesign/core/Toast";
import { Download } from "lucide-react";
import { Agents } from "../../api";
import { saveBlob } from "../../lib/download";
import { MintKey, type MintKeyState } from "../MintKey";
import { errorMessage } from "../../lib/http/client";
import { UninstallGuide } from "./UninstallGuide";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

export function ClaudeDesktopTab({
  canBundle,
  bundleFilename,
  serverKey,
  desktopJson,
  mint,
}: {
  canBundle: boolean;
  /** `stuga.mcpb`, the same for every node: the extension installs under the node's id, which is not shown. */
  bundleFilename: string;
  /** What the config calls this connection, and what the entry to delete is named. */
  serverKey: string;
  /** Null when no client on this machine can open the node's server file. */
  desktopJson: string | null;
  mint: MintKeyState;
}) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  // Open from the start when there is no one-click path to prefer.
  const [showManual, setShowManual] = useState(!canBundle);

  /** The file carries no key: once installed, it signs in through the browser. */
  async function downloadBundle() {
    setDownloading(true);
    try {
      saveBlob(await Agents.bundle(), bundleFilename);
      setDownloaded(true);
      toast({ body: t("agents.claudeDesktop.saved", { file: bundleFilename }), type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, t("agents.claudeDesktop.buildFailed")), type: "error" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <VStack gap={2}>
      {canBundle ? (
        <>
          <HStack gap={2}>
            <Button
              label={t("agents.claudeDesktop.add")}
              variant="primary"
              icon={<Download size={15} />}
              onClick={downloadBundle}
              isLoading={downloading}
            />
          </HStack>
          <Text size="sm" color="secondary">
            {tRich("agents.claudeDesktop.install", { file: bundleFilename, code: (chunks) => <code>{chunks}</code>, strong: (chunks) => <strong>{chunks}</strong> })}
          </Text>
          {downloaded && (
            <Banner
              status="success"
              title={t("agents.claudeDesktop.savedTitle", { file: bundleFilename })}
              description={t("agents.claudeDesktop.savedDescription")}
            />
          )}
        </>
      ) : (
        <Text size="sm" color="secondary">
          {t("agents.claudeDesktop.notBuilt")}
        </Text>
      )}
      {desktopJson !== null && (
        <>
          {!showManual && (
            <HStack>
              <Link onClick={() => setShowManual(true)}>{t("agents.claudeDesktop.byHand")}</Link>
            </HStack>
          )}
          {/* Mounted while hidden, so a reader who opens it keeps their place. */}
          <div hidden={!showManual} data-testid="manual-setup">
            <VStack gap={2}>
              {/* i18n-exempt: the client's name, which names its key */}
              <MintKey mint={mint} defaultName="Claude Desktop" />
              <CodeBlock
                code={desktopJson}
                title="claude_desktop_config.json"
                language="json"
                hasLanguageLabel={false}
                width="100%"
                isWrapped
                hasCopyButton
                size="sm"
              />
              <Text size="sm" color="secondary">
                {tRich("agents.claudeDesktop.paste", { strong: (chunks) => <strong>{chunks}</strong> })}
              </Text>
            </VStack>
          </div>
        </>
      )}
      {(canBundle || desktopJson !== null) && (
        <UninstallGuide host="Claude Desktop">
          {canBundle && (
            <Text size="sm">
              {tRich("agents.claudeDesktop.removeExtension", { strong: (chunks) => <strong>{chunks}</strong> })}
            </Text>
          )}
          {desktopJson !== null && (
            <Text size="sm">
              {tRich("agents.claudeDesktop.removeConfig", { server: serverKey, code: (chunks) => <code>{chunks}</code> })}
            </Text>
          )}
        </UninstallGuide>
      )}
    </VStack>
  );
}
