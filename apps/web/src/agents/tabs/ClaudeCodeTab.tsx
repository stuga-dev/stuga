import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { MintKey, type MintKeyState } from "../MintKey";
import { UninstallGuide } from "./UninstallGuide";

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
            Signing in through the browser needs an https node, so the command carries a key instead.
          </Text>
          <MintKey mint={mint} defaultName="Claude Code" />
          <CodeBlock code={cliCommand} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
          <Text size="sm" color="secondary">
            Run it in your terminal. The next Claude Code session has the node.
          </Text>
        </>
      ) : (
        <>
          <Text size="sm" color="secondary">
            1. Run this in your terminal:
          </Text>
          <CodeBlock code={cliCommand} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
          <Text size="sm" color="secondary">
            2. Run <code>/mcp</code>, choose <strong>{serverKey}</strong>, then Authenticate in your browser.
          </Text>
        </>
      )}
      <Text size="sm" color="secondary">
        To have Claude launch the server, use the Claude Desktop setup.
      </Text>
      <UninstallGuide host="Claude Code">
        <CodeBlock
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
