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

/**
 * A host that installs a server from a link: the link opens the app with this
 * node filled in, and the app signs in through the browser. A key rides in the
 * link only once one is minted, so no placeholder is ever installed.
 */
export function LinkTab({ host, link, mint }: { host: string; link: InstallLink; mint: MintKeyState }) {
  return (
    <VStack gap={2}>
      <HStack gap={2}>
        <Button label={`Add to ${host}`} variant="primary" icon={<ExternalLink size={15} />} href={link.signIn} />
      </HStack>
      <Text size="sm" color="secondary">
        Opens {host} with this node filled in. Sign in when {host} asks.
      </Text>
      {link.withKey !== null && (
        // Collapsible hides with CSS, so a minted key survives closing it.
        <Collapsible trigger="Use an agent key instead" defaultIsOpen={false}>
          <VStack gap={2}>
            <MintKey mint={mint} defaultName={host} />
            {mint.minted && (
              <HStack gap={2}>
                <Button label={`Add to ${host} with this key`} variant="secondary" icon={<ExternalLink size={15} />} href={link.withKey} />
              </HStack>
            )}
          </VStack>
        </Collapsible>
      )}
      <UninstallGuide host={host}>
        <Text size="sm" color="secondary">
          Remove the <code>{MCP_SERVER_KEY}</code> server from {host}’s MCP settings.
        </Text>
      </UninstallGuide>
    </VStack>
  );
}
