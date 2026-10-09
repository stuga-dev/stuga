import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { MintKey, type MintKeyState } from "../MintKey";
import { UninstallGuide } from "./UninstallGuide";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

/**
 * One command either way. Claude Code's browser sign-in requires the node's
 * OAuth endpoints to be https or loopback, so a plain-http LAN node names a key
 * in the command instead of sending people off to set up TLS.
 */
export function ClaudeCodeTab({
  cliCommand,
  serverKey,
  needsKey,
  mint,
}: {
  cliCommand: string;
  serverKey: string;
  needsKey: boolean;
  mint: MintKeyState;
}) {
  return (
    <VStack gap={2}>
      {needsKey ? (
        <>
          <Text size="sm" color="secondary">
            {t("agents.claudeCode.needsKey")}
          </Text>
          {/* i18n-exempt: the client's name, which names its key */}
          <MintKey mint={mint} defaultName="Claude Code" />
          <CodeBlock code={cliCommand} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
          <Text size="sm" color="secondary">
            {t("agents.claudeCode.runWithKey")}
          </Text>
        </>
      ) : (
        <>
          <Text size="sm" color="secondary">
            {t("agents.claudeCode.step1")}
          </Text>
          <CodeBlock code={cliCommand} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
          <Text size="sm" color="secondary">
            {tRich("agents.claudeCode.step2", { command: "/mcp", server: serverKey, code: (chunks) => <code>{chunks}</code>, strong: (chunks) => <strong>{chunks}</strong> })}
          </Text>
        </>
      )}
      <Text size="sm" color="secondary">
        {t("agents.claudeCode.desktopHint")}
      </Text>
      <UninstallGuide host="Claude Code">
        <CodeBlock
          // i18n-exempt: a shell command
          code={`claude mcp remove -s user ${serverKey}`}
          language="bash"
          width="100%"
          isWrapped
          hasCopyButton
          size="sm"
        />
      </UninstallGuide>
    </VStack>
  );
}
