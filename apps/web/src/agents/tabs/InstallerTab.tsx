import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import type { InstallerCommands } from "../client-configs";
import { UninstallGuide } from "./UninstallGuide";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

/** A host whose one command installs the skill and points it at this node; no key is minted or pasted. */
export function InstallerTab({
  host,
  commands,
  afterRun,
}: {
  host: string;
  commands: InstallerCommands;
  /** What the command does and what the person does after it, for a host that cannot sign in from one. */
  afterRun?: string;
}) {
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        {t("agents.installer.runOnce")}
      </Text>
      <CodeBlock code={commands.setup} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      <Text size="sm" color="secondary">
        {afterRun ?? t("agents.installer.afterRun", { host })}
      </Text>
      <UninstallGuide host={host}>
        <Text size="sm">
          {tRich("agents.installer.disconnect", { strong: (chunks) => <strong>{chunks}</strong> })}
        </Text>
        <CodeBlock code={commands.disconnect} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
        <Text size="sm">
          {tRich("agents.installer.uninstall", { strong: (chunks) => <strong>{chunks}</strong> })}
        </Text>
        <CodeBlock code={commands.uninstall} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      </UninstallGuide>
    </VStack>
  );
}
