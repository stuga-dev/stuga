import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import type { InstallerCommands } from "../client-configs";
import { UninstallGuide } from "./UninstallGuide";

/** A host whose one command installs the skill and points it at this node; no key is minted or pasted. */
export function InstallerTab({
  host,
  commands,
  signIn,
}: {
  host: string;
  commands: InstallerCommands;
  /** What the person still does after the command, for a host that cannot sign in from one. */
  signIn?: string;
}) {
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        Run once in Terminal:
      </Text>
      <CodeBlock code={commands.setup} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      <Text size="sm" color="secondary">
        {signIn ?? "Installs Stuga and opens browser sign-in."} Restart {host} when it finishes.
      </Text>
      <UninstallGuide host={host}>
        <Text size="sm">
          <strong>Disconnect this node</strong> — keeps the Stuga Skill for other nodes.
        </Text>
        <CodeBlock code={commands.disconnect} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
        <Text size="sm">
          <strong>Remove Stuga completely</strong> — only for your last Stuga node.
        </Text>
        <CodeBlock code={commands.uninstall} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      </UninstallGuide>
    </VStack>
  );
}
