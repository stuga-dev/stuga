/** The ways into the ⌘K palette from a top bar: a wide button on a large screen, a magnifier in a phone's bar. */
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Kbd } from "@astryxdesign/core/Kbd";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Search } from "lucide-react";
import { useCommandPalette, useOptionalCommandPalette } from "./command-palette/context";
import { t } from "../i18n/i18n";

/** A button that opens the palette, not a second search box. */
export function SearchBar() {
  const palette = useCommandPalette();
  return (
    <div className="topnav__search">
      {/* The Kbd is hidden from the accessible name, which would otherwise
          change with the OS; the palette answers both modifiers everywhere.
          A touch screen has no keys to press, so there it is not shown. */}
      <Button
        label={t("pages.docList.searchAll")}
        icon={<Search size={16} />}
        endContent={<Kbd keys="mod+k" aria-hidden="true" className="kbd-hint" />}
        aria-keyshortcuts="Meta+K Control+K"
        variant="secondary"
        width="100%"
        onClick={palette.open}
      />
    </div>
  );
}

/** Search in a phone's top bar, which leaves the bar's middle to the menu; nothing on a larger screen, or without a palette. */
export function PhoneSearchButton() {
  const palette = useOptionalCommandPalette();
  const { isMobile } = useAppShellMobile();
  if (!palette || !isMobile) return null;
  return <IconButton label={t("pages.docList.searchAll")} variant="ghost" icon={<Search size={18} />} onClick={palette.open} />;
}
