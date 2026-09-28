import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { PI_INSTALL_COMMAND, PI_REMOVE_COMMAND } from "../client-configs";
import { MintKey, type MintKeyState } from "../MintKey";
import { UninstallGuide } from "./UninstallGuide";

/**
 * pi-mcp-adapter signs in through the browser at any address, http included,
 * so sign-in leads on every node, as it does for Codex. A key is the
 * alternative for someone who wants a narrowed or expiring credential; the
 * package names the server `stuga` itself, whatever the node is called.
 */
export function PiTab({ piUrlEnv, piKeyEnv, mint }: { piUrlEnv: string; piKeyEnv: string; mint: MintKeyState }) {
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        1. Install the adapter and the Stuga package:
      </Text>
      <CodeBlock code={PI_INSTALL_COMMAND} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      <Text size="sm" color="secondary">
        2. Point Pi at this node, in the shell that starts it:
      </Text>
      <CodeBlock code={piUrlEnv} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      <Text size="sm" color="secondary">
        3. Start Pi, run <code>/mcp-auth stuga</code>, then approve in your browser.
      </Text>
      {/* Collapsible hides with CSS, so a minted key survives closing it. */}
      <Collapsible trigger="Use an agent key instead" defaultIsOpen={false}>
        <VStack gap={2}>
          <MintKey mint={mint} defaultName="Pi" />
          <CodeBlock
            code={piKeyEnv}
            title={mint.minted ? `Key for ${mint.minted.name}` : "Key"}
            language="bash"
            width="100%"
            isWrapped
            hasCopyButton
            size="sm"
          />
          <Text size="sm" color="secondary">
            Set it beside <code>STUGA_URL</code> and skip step 3.
          </Text>
        </VStack>
      </Collapsible>
      <UninstallGuide host="Pi">
        <CodeBlock code={PI_REMOVE_COMMAND} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      </UninstallGuide>
    </VStack>
  );
}
