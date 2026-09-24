import type { ReactNode } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Link } from "@astryxdesign/core/Link";
import { Banner } from "@astryxdesign/core/Banner";

/**
 * Removing a client, kept collapsed under the setup it undoes. What each host
 * removes is local, so every tab ends in the same place: the key or sign-in is
 * what grants access, and only revoking it takes the access back.
 */
export function UninstallGuide({ host, children }: { host: string; children: ReactNode }) {
  return (
    // Collapsible hides with CSS, so the code blocks inside do not rebuild when the guide opens.
    <Collapsible trigger={`Uninstall from ${host}`} defaultIsOpen={false}>
      <VStack gap={2}>
        <Banner
          status="warning"
          title="Local removal does not revoke access"
          description="Also revoke the connection under Connected agents."
        />
        {children}
        <Text size="sm" color="secondary">
          Then <Link href="#connected-agents">revoke the connection</Link> and restart {host}.
        </Text>
      </VStack>
    </Collapsible>
  );
}
