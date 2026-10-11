/** The top bar of a full page outside the library: back to All documents, the brand, the page's name and the personal controls. */
import { useNavigate } from "react-router-dom";
import { TopNav } from "@astryxdesign/core/TopNav";
import { Heading } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ArrowLeft } from "lucide-react";
import { Brand } from "./Brand";
import { AccountMenu } from "./AccountMenu";
import { NotificationsBell } from "./NotificationsBell";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { PhoneSearchButton } from "./SearchTrigger";
import { usePageTitle } from "../state/branding";
import { t } from "../i18n/i18n";

interface AppTopNavProps {
  /** Names the page, in the bar and as the nav landmark's accessible name. */
  title: string;
  /** Titles the browser tab; `title` when omitted. */
  pageTitle?: string;
  /** For pages whose content belongs to the active workspace. */
  hasWorkspaceSwitcher?: boolean;
}

export function AppTopNav({ title, pageTitle, hasWorkspaceSwitcher = false }: AppTopNavProps) {
  const nav = useNavigate();
  usePageTitle(pageTitle ?? title);
  return (
    <TopNav
      label={title}
      // The heading slot, unlike the start content, stays in a phone's bar.
      heading={
        <HStack gap={2} vAlign="center">
          <IconButton label={t("common.allDocuments")} variant="ghost" icon={<ArrowLeft size={18} />} onClick={() => nav("/")} />
          <div className="brand">
            <Brand />
            <Heading level={1}>{title}</Heading>
          </div>
        </HStack>
      }
      startContent={
        hasWorkspaceSwitcher ? (
          <HStack gap={2} vAlign="center">
            <span className="topnav__sep" aria-hidden="true" />
            <WorkspaceSwitcher />
          </HStack>
        ) : undefined
      }
      endContent={
        <HStack gap={1} vAlign="center">
          <PhoneSearchButton />
          <NotificationsBell />
          <AccountMenu />
        </HStack>
      }
    />
  );
}
