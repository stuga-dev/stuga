import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { ExternalLink } from "lucide-react";
import { MCP_SERVER_KEY } from "@stuga/protocol/domain/node-name";
import type { InstallLink } from "../client-configs";
import { MintKey, type MintKeyState } from "../MintKey";
import { UninstallGuide } from "./UninstallGuide";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

/**
 * A host that installs a server from a link: the link opens the app with this
 * node filled in, and the app signs in through the browser. A key rides in the
 * link only once one is minted, so no placeholder is ever installed.
 */
export function LinkTab({ host, link, mint }: { host: string; link: InstallLink; mint: MintKeyState }) {
  return (
    <VStack gap={2}>
      <HStack gap={2}>
        <Button label={t("agents.link.add", { host })} variant="primary" icon={<ExternalLink size={15} />} href={link.signIn} />
      </HStack>
      <Text size="sm" color="secondary">
        {t("agents.link.opens", { host })}
      </Text>
      {link.withKey !== null && (
        // Collapsible hides with CSS, so a minted key survives closing it.
        <Collapsible trigger={t("agents.setup.useKeyInstead")} defaultIsOpen={false}>
          <VStack gap={2}>
            <MintKey mint={mint} defaultName={host} />
            {mint.minted && (
              <HStack gap={2}>
                <Button label={t("agents.link.addWithKey", { host })} variant="secondary" icon={<ExternalLink size={15} />} href={link.withKey} />
              </HStack>
            )}
          </VStack>
        </Collapsible>
      )}
      <UninstallGuide host={host}>
        <Text size="sm" color="secondary">
          {tRich("agents.link.remove", { server: MCP_SERVER_KEY, host, code: (chunks) => <code>{chunks}</code> })}
        </Text>
      </UninstallGuide>
    </VStack>
  );
}
