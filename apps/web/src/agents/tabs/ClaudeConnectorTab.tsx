import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { ExternalLink } from "lucide-react";

/** Claude has no "add this URL" link, so the URL is pasted by hand. */
const CLAUDE_CONNECTORS = "https://claude.ai/settings/connectors";

export function ClaudeConnectorTab({ mcpUrl }: { mcpUrl: string }) {
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        1. In Claude, open Settings → Connectors → <strong>Add custom connector</strong>.
      </Text>
      <Text size="sm" color="secondary">
        2. Paste this URL, then sign in to Stuga.
      </Text>
      {/* Without a title the copy button is positioned over a wrapped URL's last characters. */}
      <CodeBlock code={mcpUrl} title="MCP endpoint" width="100%" isWrapped hasCopyButton size="sm" />
      <HStack gap={2}>
        <Button
          label="Open Claude connectors"
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
