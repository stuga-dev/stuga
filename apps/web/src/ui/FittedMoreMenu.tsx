/**
 * Astryx MoreMenu with its height cap lifted. MoreMenu stops at 300px and
 * scrolls, which hides the last rows of an item's menu (Move to Trash among
 * them) with nothing to say there is more; this one is bounded by the window only.
 */
import type { Ref } from "react";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { useIcon } from "@astryxdesign/core/Icon";
import type { LayerAlignment } from "@astryxdesign/core/Layer";

/** Above the longest item menu; the window still bounds it, and it scrolls past that. */
const MENU_MAX_HEIGHT = 720;

interface FittedMoreMenuProps {
  label: string;
  items: DropdownMenuOption[];
  alignment?: LayerAlignment;
  size?: "sm" | "md";
  isDisabled?: boolean;
  /** The trigger button. */
  ref?: Ref<HTMLButtonElement>;
}

export function FittedMoreMenu({ label, items, alignment = "end", size = "sm", isDisabled = false, ref }: FittedMoreMenuProps) {
  const moreIcon = useIcon("moreHorizontal");
  return (
    <DropdownMenu
      className="astryx-more-menu"
      button={{ label, icon: moreIcon, variant: "ghost", size, isDisabled, tooltip: label, isIconOnly: true, ref }}
      items={items}
      alignment={alignment}
      menuMaxHeight={MENU_MAX_HEIGHT}
      hasChevron={false}
    />
  );
}
