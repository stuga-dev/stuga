import type { ReactNode } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Link } from "@astryxdesign/core/Link";
import { Banner } from "@astryxdesign/core/Banner";
import { t } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

/**
 * Removing a client, kept collapsed under the setup it undoes. What each host
 * removes is local, so every tab ends in the same place: the key or sign-in is
 * what grants access, and only revoking it takes the access back.
 */
export function UninstallGuide({ host, children }: { host: string; children: ReactNode }) {
  return (
    // Collapsible hides with CSS, so the code blocks inside do not rebuild when the guide opens.
    <Collapsible trigger={t("agents.uninstall.trigger", { host })} defaultIsOpen={false}>
      <VStack gap={2}>
        <Banner
          status="warning"
          title={t("agents.uninstall.warningTitle")}
          description={t("agents.uninstall.warningDescription", { section: t("agents.connected.title") })}
        />
        {children}
        <Text size="sm" color="secondary">
          {tRich("agents.uninstall.then", { host, link: (chunks) => <Link href="#connected-agents">{chunks}</Link> })}
        </Text>
      </VStack>
    </Collapsible>
  );
}
