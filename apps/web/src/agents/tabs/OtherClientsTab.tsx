import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { MintKey, type MintKeyState } from "../MintKey";
import { t } from "../../i18n/i18n";

export function OtherClientsTab({
  httpJson,
  mint,
}: {
  httpJson: string;
  mint: MintKeyState;
}) {
  const { minted } = mint;
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        {t("agents.other.intro")}
      </Text>
      <MintKey mint={mint} />
      <CodeBlock
        code={httpJson}
        title={minted ? t("agents.other.configFor", { name: minted.name }) : t("agents.other.config")}
        language="json"
        hasLanguageLabel={false}
        width="100%"
        isWrapped
        hasCopyButton
        size="sm"
      />
      {/* The key alone too, for a client whose settings take an API key rather than a config. */}
      {minted && <CodeBlock code={minted.token} title={t("agents.setup.keyFor", { name: minted.name })} width="100%" isWrapped hasCopyButton size="sm" />}
      <Text size="sm" color="secondary">
        {t("agents.other.oauth")}
      </Text>
    </VStack>
  );
}
