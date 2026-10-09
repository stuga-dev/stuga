import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { PI_INSTALL_COMMAND, PI_REMOVE_COMMAND } from "../client-configs";
import { MintKey, type MintKeyState } from "../MintKey";
import { UninstallGuide } from "./UninstallGuide";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

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
        {t("agents.pi.step1")}
      </Text>
      <CodeBlock code={PI_INSTALL_COMMAND} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      <Text size="sm" color="secondary">
        {t("agents.pi.step2")}
      </Text>
      <CodeBlock code={piUrlEnv} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      <Text size="sm" color="secondary">
        {tRich("agents.pi.step3", { command: "/mcp-auth stuga", code: (chunks) => <code>{chunks}</code> })}
      </Text>
      {/* Collapsible hides with CSS, so a minted key survives closing it. */}
      <Collapsible trigger={t("agents.setup.useKeyInstead")} defaultIsOpen={false}>
        <VStack gap={2}>
          {/* i18n-exempt: the client's name, which names its key */}
          <MintKey mint={mint} defaultName="Pi" />
          <CodeBlock
            code={piKeyEnv}
            title={mint.minted ? t("agents.setup.keyFor", { name: mint.minted.name }) : t("agents.setup.key")}
            language="bash"
            width="100%"
            isWrapped
            hasCopyButton
            size="sm"
          />
          <Text size="sm" color="secondary">
            {tRich("agents.pi.keyBeside", { variable: "STUGA_URL", code: (chunks) => <code>{chunks}</code> })}
          </Text>
        </VStack>
      </Collapsible>
      <UninstallGuide host="Pi">
        <CodeBlock code={PI_REMOVE_COMMAND} language="bash" width="100%" isWrapped hasCopyButton size="sm" />
      </UninstallGuide>
    </VStack>
  );
}
