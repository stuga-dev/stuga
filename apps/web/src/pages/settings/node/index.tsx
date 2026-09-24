/**
 * Node settings: the machine, not a workspace. The section is the :category URL
 * segment, so each is linkable and the back button walks them.
 */
import { Activity } from "react";
import { useParams } from "react-router-dom";
import { Card } from "@astryxdesign/core/Card";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Banner } from "@astryxdesign/core/Banner";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Server } from "lucide-react";
import { LoadFailed } from "../../../ui/LoadFailed";
import { PageColumn } from "../../../ui/PageColumn";
import { asNodeCategory, type NodeCategory } from "./categories";
import { useNodeSettings } from "./useNodeSettings";
import { AiSection } from "./AiSection";
import { NotificationsSection } from "./NotificationsSection";
import { AccessSection } from "./AccessSection";
import { StorageSection } from "./StorageSection";
import { BackupsSection } from "./BackupsSection";
import { BrandingSection } from "./BrandingSection";
import { AboutSection } from "./AboutSection";

export function NodeSettingsPage() {
  const category = asNodeCategory(useParams().category);
  const { allowed, ai, setAi, ops, setOps, failed, retry } = useNodeSettings();

  if (failed) {
    return (
      <PageColumn>
        <LoadFailed icon={<Server size={28} />} title="Couldn’t load node settings" onRetry={retry} />
      </PageColumn>
    );
  }

  if (allowed === null) {
    return (
      <PageColumn>
        <Spinner />
      </PageColumn>
    );
  }

  // The rail hides this group from non-administrators; this answers a deep link.
  if (!allowed) {
    return (
      <PageColumn width={640}>
        <Card>
          <VStack gap={2}>
            <Heading level={2}>You are not this node&apos;s administrator</Heading>
            <Text type="supporting" color="secondary">
              Only node administrators can change these settings. Ask one to add you.
            </Text>
          </VStack>
        </Card>
      </PageColumn>
    );
  }

  const staleAiKey = (ai?.chat.endpoints.some((e) => e.api_key_stale) ?? false) || ai?.embed.api_key_stale;
  const needs = category === "ai" ? ai : category === "access" ? true : ops;
  const shown = (key: NodeCategory) => (key === category ? "visible" : "hidden");

  return (
    <PageColumn>
      <VStack gap={5}>
        {staleAiKey && (
          <Banner
            status="warning"
            title="A provider key is missing from this node&apos;s files"
            description="Paste the key again to restore AI."
          />
        )}
        {/* Hidden, not unmounted: each section's unsaved draft must survive a visit to another. */}
        <Activity mode={shown("ai")}>{ai && <AiSection settings={ai} onSaved={setAi} />}</Activity>
        <Activity mode={shown("notifications")}>{ops && <NotificationsSection ops={ops} onSaved={setOps} />}</Activity>
        <Activity mode={shown("access")}>
          <AccessSection ops={ops} onSaved={setOps} />
        </Activity>
        <Activity mode={shown("storage")}>{ops && <StorageSection ops={ops} onSaved={setOps} />}</Activity>
        <Activity mode={shown("backups")}>{ops && category === "backups" && <BackupsSection ops={ops} onSaved={setOps} />}</Activity>
        <Activity mode={shown("branding")}>{ops && <BrandingSection ops={ops} onSaved={setOps} />}</Activity>
        <Activity mode={shown("about")}>{ops && <AboutSection ops={ops} onSaved={setOps} />}</Activity>
        {!needs && <Spinner />}
      </VStack>
    </PageColumn>
  );
}
