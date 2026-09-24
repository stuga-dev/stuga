/**
 * The library sidebar: New, the library views, the AI destinations (pages of
 * their own, so never shown as selected), and Trash and Settings pinned to the bottom.
 */
import { SideNav } from "@astryxdesign/core/SideNav";
import { SideNavItem } from "@astryxdesign/core/SideNav";
import { SideNavSection } from "@astryxdesign/core/SideNav";
import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Files, Library, Settings, Sparkles, Star, Trash2, Users as UsersIcon, ListChecks } from "lucide-react";
import { LibraryCreateMenu } from "./LibraryCreateMenu";

/** Which library view is showing. */
export type LibraryView = "browse" | "shared" | "trash" | "favorites" | "collections";

interface LibraryNavProps {
  /** Null while something else (search results) has the content pane, so nothing reads as selected. */
  view: LibraryView | null;
  onViewChange: (view: LibraryView) => void;
  onNewDoc: () => void;
  onNewDatabase: () => void;
  onNewFolder: () => void;
  onImport: () => void;
  onAsk: () => void;
  onReview: () => void;
  onSettings: () => void;
  sharedCount?: number | null;
  favoriteCount?: number | null;
}

export function LibraryNav({
  view,
  onViewChange,
  onNewDoc,
  onNewDatabase,
  onNewFolder,
  onImport,
  onAsk,
  onReview,
  onSettings,
  sharedCount,
  favoriteCount,
}: LibraryNavProps) {
  return (
    <SideNav
      resizable={{ defaultWidth: 248, minWidth: 200, maxWidth: 380, autoSaveId: "stuga-library-nav" }}
      collapsible
      // The footer stays at the bottom of the nav, whatever the sections above it take.
      footer={
        <SideNavSection title="More" isHeaderHidden>
          <SideNavItem label="Trash" icon={<Trash2 size={16} />} isSelected={view === "trash"} onClick={() => onViewChange("trash")} />
          <SideNavItem label="Settings" icon={<Settings size={16} />} onClick={onSettings} />
        </SideNavSection>
      }
      topContent={
        <HStack padding={2}>
          <StackItem size="fill">
            <LibraryCreateMenu
              fill
              onNewDoc={onNewDoc}
              onNewDatabase={onNewDatabase}
              onNewFolder={onNewFolder}
              onImport={onImport}
            />
          </StackItem>
        </HStack>
      }
    >
      <SideNavSection title="Library">
        <SideNavItem label="All documents" icon={<Files size={16} />} isSelected={view === "browse"} onClick={() => onViewChange("browse")} />
        <SideNavItem
          label="Favorites"
          icon={<Star size={16} />}
          isSelected={view === "favorites"}
          onClick={() => onViewChange("favorites")}
          endContent={favoriteCount ? <Badge variant="neutral" label={String(favoriteCount)} /> : undefined}
        />
        <SideNavItem
          label="Shared with me"
          icon={<UsersIcon size={16} />}
          isSelected={view === "shared"}
          onClick={() => onViewChange("shared")}
          endContent={sharedCount ? <Badge variant="neutral" label={String(sharedCount)} /> : undefined}
        />
        <SideNavItem
          label="Collections"
          icon={<Library size={16} />}
          isSelected={view === "collections"}
          onClick={() => onViewChange("collections")}
        />
      </SideNavSection>

      <SideNavSection title="AI">
        <SideNavItem label="Ask your documents" icon={<Sparkles size={16} />} onClick={onAsk} />
        <SideNavItem label="Review AI edits" icon={<ListChecks size={16} />} onClick={onReview} />
      </SideNavSection>
    </SideNav>
  );
}
