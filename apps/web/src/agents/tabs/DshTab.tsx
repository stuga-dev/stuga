import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DSH_INSTALL_COMMAND, DSH_REMOVE_COMMAND } from "../client-configs";
import { MintKey, type MintKeyState } from "../MintKey";
import { UninstallGuide } from "./UninstallGuide";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

/** The product is DeepSeek Harness; `dsh` appears only where it is the command being run. */
export function DshTab({ dshEnv, mint }: { dshEnv: string; mint: MintKeyState }) {
  return (
    <VStack gap={2}>
      <Text size="sm" color="secondary">
        {t("agents.dsh.intro", { review: t("common.reviewAiEdits") })}
      </Text>
      {/* i18n-exempt: the client's name, which names its key */}
      <MintKey mint={mint} defaultName="DeepSeek Harness" />
      <Text size="sm" color="secondary">
        {tRich("agents.dsh.step1", { profile: "web", code: (chunks) => <code>{chunks}</code> })}
      </Text>
      <CodeBlock code={DSH_INSTALL_COMMAND} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      <Text size="sm" color="secondary">
        {tRich("agents.dsh.step2", { file: "$DSH_HOME/.env", code: (chunks) => <code>{chunks}</code> })}
      </Text>
      <CodeBlock
        code={dshEnv}
        title={mint.minted ? t("agents.dsh.environmentFor", { name: mint.minted.name }) : t("agents.dsh.environment")}
        width="100%"
        isWrapped
        hasCopyButton
        size="sm"
      />
      <Text size="sm" color="secondary">
        {t("agents.dsh.plugin")}
      </Text>
      <UninstallGuide host="DeepSeek Harness">
        <CodeBlock code={DSH_REMOVE_COMMAND} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      </UninstallGuide>
    </VStack>
  );
}
