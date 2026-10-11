/**
 * The library sidebar: New, the library views, the AI destinations (pages of
 * their own, so never shown as selected), and Trash and Settings pinned to the bottom.
 */
import { SideNav, useSideNavCollapse } from "@astryxdesign/core/SideNav";
import { SideNavItem } from "@astryxdesign/core/SideNav";
import { SideNavSection } from "@astryxdesign/core/SideNav";
import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Files, Library, Settings, Sparkles, Star, Trash2, Users as UsersIcon, ListChecks } from "lucide-react";
import { LibraryCreateMenu, type LibraryCreateActions } from "./LibraryCreateMenu";
import { t } from "../i18n/i18n";
import { fmtInt } from "../lib/format";
import { useReviewQueue } from "../review/review-queue";

/** Which library view is showing. */
export type LibraryView = "browse" | "shared" | "trash" | "favorites" | "collections";

interface LibraryNavProps {
  /** Null while something else (search results) has the content pane, so nothing reads as selected. */
  view: LibraryView | null;
  onViewChange: (view: LibraryView) => void;
  /** Null for someone who creates nothing here, a guest: then there is no New, and no Collections, which only their maker has. */
  createActions: LibraryCreateActions | null;
  onAsk: () => void;
  onReview: () => void;
  onSettings: () => void;
  sharedCount?: number | null;
  favoriteCount?: number | null;
}

export function LibraryNav({
  view,
  onViewChange,
  createActions,
  onAsk,
  onReview,
  onSettings,
  sharedCount,
  favoriteCount,
}: LibraryNavProps) {
  const queue = useReviewQueue();
  return (
    <SideNav
      resizable={{ defaultWidth: 248, minWidth: 200, maxWidth: 380, autoSaveId: "stuga-library-nav" }}
      collapsible
      // The footer stays at the bottom of the nav, whatever the sections above it take.
      footer={
        <SideNavSection title={t("library.nav.more")} isHeaderHidden>
          <SideNavItem label={t("library.nav.trash")} icon={<Trash2 size={16} />} isSelected={view === "trash"} onClick={() => onViewChange("trash")} />
          <SideNavItem label={t("common.settings")} icon={<Settings size={16} />} onClick={onSettings} />
        </SideNavSection>
      }
      topContent={createActions && <NavCreateMenu actions={createActions} />}
    >
      <SideNavSection title={t("library.nav.library")}>
        <SideNavItem label={t("common.allDocuments")} icon={<Files size={16} />} isSelected={view === "browse"} onClick={() => onViewChange("browse")} />
        <SideNavItem
          label={t("library.nav.favorites")}
          icon={<Star size={16} />}
          isSelected={view === "favorites"}
          onClick={() => onViewChange("favorites")}
          endContent={favoriteCount ? <Badge variant="neutral" label={fmtInt(favoriteCount)} /> : undefined}
        />
        <SideNavItem
          label={t("library.nav.shared")}
          icon={<UsersIcon size={16} />}
          isSelected={view === "shared"}
          onClick={() => onViewChange("shared")}
          endContent={sharedCount ? <Badge variant="neutral" label={fmtInt(sharedCount)} /> : undefined}
        />
        {createActions && (
          <SideNavItem
            label={t("library.nav.collections")}
            icon={<Library size={16} />}
            isSelected={view === "collections"}
            onClick={() => onViewChange("collections")}
          />
        )}
      </SideNavSection>

      <SideNavSection title={t("library.nav.ai")}>
        <SideNavItem label={t("library.nav.ask")} icon={<Sparkles size={16} />} onClick={onAsk} />
        <SideNavItem
          label={t("common.reviewAiEdits")}
          icon={<ListChecks size={16} />}
          onClick={onReview}
          endContent={
            queue && queue.count > 0 ? (
              <Badge
                variant="warning"
                label={queue.capped ? t("library.nav.reviewCountCapped", { count: queue.count }) : fmtInt(queue.count)}
              />
            ) : undefined
          }
        />
      </SideNavSection>
    </SideNav>
  );
}

/** New at the top of the nav: full width, or an icon button that fits the collapsed rail. */
function NavCreateMenu({ actions }: { actions: LibraryCreateActions }) {
  const { isCollapsed } = useSideNavCollapse();
  return (
    <HStack padding={2} hAlign={isCollapsed ? "center" : undefined}>
      {isCollapsed ? (
        <LibraryCreateMenu {...actions} isIconOnly />
      ) : (
        <StackItem size="fill">
          <LibraryCreateMenu {...actions} fill />
        </StackItem>
      )}
    </HStack>
  );
}
