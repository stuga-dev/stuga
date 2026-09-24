import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { MintKey, type MintKeyState } from "../MintKey";

export function OtherClientsTab({
  httpJson,
  workspaceName,
  mint,
}: {
  httpJson: string;
  workspaceName: string | null;
  mint: MintKeyState;
}) {
  const { minted } = mint;
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        For MCP clients using streamable HTTP. Name a key to fill the config. It starts in{" "}
        {workspaceName ? <strong>{workspaceName}</strong> : "this workspace"} and uses your access elsewhere.
      </Text>
      <MintKey mint={mint} />
      <CodeBlock
        code={httpJson}
        title={minted ? `Config for ${minted.name}` : "Client config"}
        language="json"
        hasLanguageLabel={false}
        width="100%"
        isWrapped
        hasCopyButton
        size="sm"
      />
      {/* The key alone too, for a client whose settings take an API key rather than a config. */}
      {minted && <CodeBlock code={minted.token} title={`Key for ${minted.name}`} width="100%" isWrapped hasCopyButton size="sm" />}
      <Text size="sm" color="secondary">
        OAuth clients can sign in instead of using a key.
      </Text>
    </VStack>
  );
}
