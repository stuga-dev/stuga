/**
 * The ways AI comes in, offered in an empty library until dismissed, so they
 * stay within reach after the first-run screen is gone: anyone's own agent, and
 * for a node administrator the built-in AI and semantic search, each marked On
 * once set up. Dismissing is remembered in this browser only.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@astryxdesign/core/Card";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Item } from "@astryxdesign/core/Item";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Divider } from "@astryxdesign/core/Divider";
import { Plug, Search, Sparkles, X } from "lucide-react";
import { NodeSettings, type NodeAiSettings } from "../api";
import { HALF_COPY } from "../pages/settings/node/ai-form";
import { useIsNodeAdmin } from "../state/node-admin";
import { readStored, writeStored } from "../lib/storage";
import { t } from "../i18n/i18n";

const DISMISSED_KEY = "stuga_library_setup_dismissed";
const AGENTS_PATH = "/settings/agents";
const NODE_AI_PATH = "/settings/node/ai";

export function SetupCard() {
  const nav = useNavigate();
  const isAdmin = useIsNodeAdmin();
  const [dismissed, setDismissed] = useState(() => readStored("local", DISMISSED_KEY) === "1");
  /** The node's AI settings, read for an administrator only; null until then. */
  const [ai, setAi] = useState<NodeAiSettings | null>(null);

  useEffect(() => {
    if (!isAdmin || dismissed) return;
    let alive = true;
    NodeSettings.ai()
      .then((s) => alive && setAi(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isAdmin, dismissed]);

  // Waits for the role, so rows do not appear under the reader's eyes.
  if (dismissed || isAdmin === null || (isAdmin && ai === null)) return null;

  const dismiss = () => {
    writeStored("local", DISMISSED_KEY, "1");
    setDismissed(true);
  };
  const row = (icon: React.ReactNode, title: string, about: string, on: boolean, path: string) => (
    <Item
      startContent={icon}
      label={<Text weight="semibold">{title}</Text>}
      description={about}
      descriptionLines={3}
      align="start"
      endContent={
        on ? (
          <Text type="supporting">{t("auth.onboarding.on")}</Text>
        ) : (
          <Button label={t("auth.onboarding.setUp")} variant="secondary" size="sm" onClick={() => nav(path)} />
        )
      }
    />
  );

  return (
    <Card width="100%" maxWidth={560}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" justify="between">
          <Heading level={2}>{t("library.setup.title")}</Heading>
          <IconButton label={t("common.dismiss")} variant="ghost" size="sm" icon={<X size={16} />} onClick={dismiss} />
        </HStack>
        {row(<Plug size={18} />, t("common.yourAiAgents"), t("auth.onboarding.agentsAbout"), false, AGENTS_PATH)}
        {isAdmin && ai && (
          <>
            <Divider />
            {row(<Sparkles size={18} />, HALF_COPY.chat.title, HALF_COPY.chat.about, ai.chat.endpoints.length > 0, NODE_AI_PATH)}
            <Divider />
            {row(<Search size={18} />, HALF_COPY.search.title, HALF_COPY.search.about, !!ai.embed.model, NODE_AI_PATH)}
          </>
        )}
      </VStack>
    </Card>
  );
}
