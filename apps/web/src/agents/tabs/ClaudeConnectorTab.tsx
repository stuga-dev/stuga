import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { ExternalLink } from "lucide-react";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

/** Claude has no "add this URL" link, so the URL is pasted by hand. */
const CLAUDE_CONNECTORS = "https://claude.ai/settings/connectors";

export function ClaudeConnectorTab({ mcpUrl }: { mcpUrl: string }) {
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        {tRich("agents.claudeConnector.step1", { strong: (chunks) => <strong>{chunks}</strong> })}
      </Text>
      <Text size="sm" color="secondary">
        {t("agents.claudeConnector.step2")}
      </Text>
      {/* Without a title the copy button is positioned over a wrapped URL's last characters. */}
      <CodeBlock code={mcpUrl} title={t("agents.claudeConnector.endpoint")} width="100%" isWrapped hasCopyButton size="sm" />
      <HStack gap={2}>
        <Button
          label={t("agents.claudeConnector.open")}
          variant="secondary"
          size="sm"
          endContent={<ExternalLink size={14} />}
          href={CLAUDE_CONNECTORS}
          target="_blank"
          rel="noopener noreferrer"
        />
      </HStack>
    </VStack>
  );
}
