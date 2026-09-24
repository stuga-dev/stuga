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

interface AppTopNavProps {
  /** Names the page, in the bar and as the nav landmark's accessible name. */
  title: string;
  /** For pages whose content belongs to the active workspace. */
  hasWorkspaceSwitcher?: boolean;
}

export function AppTopNav({ title, hasWorkspaceSwitcher = false }: AppTopNavProps) {
  const nav = useNavigate();
  return (
    <TopNav
      label={title}
      startContent={
        <HStack gap={2} vAlign="center">
          <IconButton label="All documents" variant="ghost" icon={<ArrowLeft size={18} />} onClick={() => nav("/")} />
          <div className="brand">
            <Brand />
            <Heading level={1}>{title}</Heading>
          </div>
          {hasWorkspaceSwitcher && (
            <>
              <span className="topnav__sep" aria-hidden="true" />
              <WorkspaceSwitcher />
            </>
          )}
        </HStack>
      }
      endContent={
        <HStack gap={1} vAlign="center">
          <NotificationsBell />
          <AccountMenu />
        </HStack>
      }
    />
  );
}
