import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DSH_INSTALL_COMMAND, DSH_REMOVE_COMMAND } from "../client-configs";
import { MintKey, type MintKeyState } from "../MintKey";
import { UninstallGuide } from "./UninstallGuide";

/** The product is DeepSeek Harness; `dsh` appears only where it is the command being run. */
export function DshTab({ dshEnv, mint }: { dshEnv: string; mint: MintKeyState }) {
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        DeepSeek Harness connects with a named key. Its edits appear in Review AI edits.
      </Text>
      <MintKey mint={mint} defaultName="DeepSeek Harness" />
      <Text size="sm" color="secondary">
        1. Install the plugin for your profile (the web UI uses <code>web</code>):
      </Text>
      <CodeBlock code={DSH_INSTALL_COMMAND} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      <Text size="sm" color="secondary">
        2. Add these to <code>$DSH_HOME/.env</code>, then restart DeepSeek Harness:
      </Text>
      <CodeBlock
        code={dshEnv}
        title={mint.minted ? `Environment for ${mint.minted.name}` : "Environment"}
        width="100%"
        isWrapped
        hasCopyButton
        size="sm"
      />
      <Text size="sm" color="secondary">
        The plugin adds Stuga tools and playbooks for research, editing and databases.
      </Text>
      <UninstallGuide host="DeepSeek Harness">
        <CodeBlock code={DSH_REMOVE_COMMAND} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      </UninstallGuide>
    </VStack>
  );
}
