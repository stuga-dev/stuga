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

export function ClaudeDesktopTab({
  canBundle,
  bundleFilename,
  serverKey,
  desktopJson,
  mint,
  onKeyCreated,
}: {
  canBundle: boolean;
  /** `stuga.mcpb`, the same for every node: the extension installs under the node's id, which is not shown. */
  bundleFilename: string;
  /** What the config calls this connection, and what the entry to delete is named. */
  serverKey: string;
  /** Null when no client on this machine can open the node's server file. */
  desktopJson: string | null;
  mint: MintKeyState;
  onKeyCreated: () => void;
}) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  // Open from the start when there is no one-click path to prefer.
  const [showManual, setShowManual] = useState(!canBundle);

  /** The node mints a key sealed inside the file; this page never sees its token. */
  async function downloadBundle() {
    setDownloading(true);
    try {
      saveBlob(await Agents.bundle(), bundleFilename);
      setDownloaded(true);
      toast({ body: `${bundleFilename} saved. Double-click it to install.`, type: "info" });
      onKeyCreated();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn’t build the extension."), type: "error" });
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
              label="Add to Claude Desktop"
              variant="primary"
              icon={<Download size={15} />}
              onClick={downloadBundle}
              isLoading={downloading}
            />
          </HStack>
          <Text size="sm" color="secondary">
            Open <code>{bundleFilename}</code>, click <strong>Install</strong>, then fully restart Claude.
          </Text>
          {/* The key is only a risk once the file exists, so this waits for the download. */}
          {downloaded && (
            <Banner
              status="success"
              title={`${bundleFilename} saved — install it, then restart Claude`}
              description="The file carries a working key: delete it once installed. If installation fails, revoke its key below and download a new file."
            />
          )}
        </>
      ) : (
        <Text size="sm" color="secondary">
          The MCP server wasn’t built for this development run.
        </Text>
      )}
      {desktopJson !== null && (
        <>
          {!showManual && (
            <HStack>
              <Link onClick={() => setShowManual(true)}>Set it up by hand instead</Link>
            </HStack>
          )}
          {/* Mounted while hidden, so a reader who opens it keeps their place. */}
          <div hidden={!showManual} data-testid="manual-setup">
            <VStack gap={2}>
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
                In Claude Desktop, open Settings → Developer → <strong>Edit Config</strong>, paste this, then fully restart Claude.
              </Text>
            </VStack>
          </div>
        </>
      )}
      {(canBundle || desktopJson !== null) && (
        <UninstallGuide host="Claude Desktop">
          {canBundle && (
            <Text size="sm">
              In Claude Desktop, open Settings → Extensions and remove <strong>Stuga</strong>.
            </Text>
          )}
          {desktopJson !== null && (
            <Text size="sm">
              If you pasted the config instead, delete its <code>{serverKey}</code> entry.
            </Text>
          )}
        </UninstallGuide>
      )}
    </VStack>
  );
}
