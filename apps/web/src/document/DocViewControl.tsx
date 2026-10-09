/**
 * The document's view options, all per browser: zoom, page width and citation
 * markers. A popover rather than a menu, so it stays open across repeated zoom nudges.
 */
import { Popover } from "@astryxdesign/core/Popover";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Switch } from "@astryxdesign/core/Switch";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { formatLocale, t, type MessageKey } from "../i18n/i18n";

export type WidthKey = "narrow" | "medium" | "wide" | "full";
export const WIDTH_ORDER: WidthKey[] = ["narrow", "medium", "wide", "full"];
const WIDTH_LABELS: Record<WidthKey, MessageKey> = {
  narrow: "document.view.widthNarrow",
  medium: "document.view.widthMedium",
  wide: "document.view.widthWide",
  full: "document.view.widthFull",
};

/** Percent, applied as CSS `zoom` on the editor sheet. */
export const ZOOM_PRESETS = [75, 100, 125, 150, 175, 200] as const;
export const ZOOM_DEFAULT = 100;

/** A zoom level as the reader's locale writes a percentage: "125%". */
function percent(zoom: number): string {
  return new Intl.NumberFormat(formatLocale(), { style: "percent" }).format(zoom / 100);
}

export function DocViewControl({
  zoom,
  onZoom,
  width,
  onWidth,
  showCitations,
  onShowCitations,
}: {
  zoom: number;
  onZoom: (next: number) => void;
  width: WidthKey;
  onWidth: (next: WidthKey) => void;
  showCitations: boolean;
  onShowCitations: (next: boolean) => void;
}) {
  const idx = (ZOOM_PRESETS as readonly number[]).indexOf(zoom);
  const canZoomOut = idx > 0;
  const canZoomIn = idx >= 0 && idx < ZOOM_PRESETS.length - 1;

  return (
    <Popover
      label={t("document.view.label")}
      placement="below"
      alignment="end"
      width={340}
      content={
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" hAlign="between">
            <Text type="label">{t("document.view.zoom")}</Text>
            <HStack gap={0.5} vAlign="center">
              <IconButton
                label={t("document.view.zoomOut")}
                variant="ghost"
                size="sm"
                icon={<Minus size={16} />}
                isDisabled={!canZoomOut}
                onClick={() => onZoom(ZOOM_PRESETS[idx - 1] ?? ZOOM_DEFAULT)}
              />
              {/* No tooltips here: one opening while this popover animates in trips the browser's nested-show guard. */}
              <Button
                label={
                  zoom === ZOOM_DEFAULT
                    ? percent(zoom)
                    : t("document.view.zoomReset", { zoom: percent(zoom), reset: percent(ZOOM_DEFAULT) })
                }
                variant="ghost"
                size="sm"
                width={64}
                isDisabled={zoom === ZOOM_DEFAULT}
                onClick={() => onZoom(ZOOM_DEFAULT)}
              />
              <IconButton
                label={t("document.view.zoomIn")}
                variant="ghost"
                size="sm"
                icon={<Plus size={16} />}
                isDisabled={!canZoomIn}
                onClick={() => onZoom(ZOOM_PRESETS[idx + 1] ?? ZOOM_DEFAULT)}
              />
            </HStack>
          </HStack>

          <VStack gap={1}>
            <Text type="label">{t("document.view.pageWidth")}</Text>
            <SegmentedControl label={t("document.view.pageWidth")} size="sm" layout="fill" value={width} onChange={(v) => onWidth(v as WidthKey)}>
              {WIDTH_ORDER.map((w) => (
                <SegmentedControlItem key={w} value={w} label={t(WIDTH_LABELS[w])} />
              ))}
            </SegmentedControl>
          </VStack>

          <Divider />

          <Switch
            label={t("document.view.citations")}
            description={t("document.view.citationsNote")}
            size="sm"
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
            value={showCitations}
            onChange={onShowCitations}
          />
        </VStack>
      }
    >
      {/* No tooltip: focus returns here while the popover is still closing. */}
      <Button label={t("document.view.trigger", { zoom: percent(zoom) })} variant="ghost" size="sm">
        <HStack gap={0.5} vAlign="center">
          <Text type="inherit" hasTabularNumbers>{percent(zoom)}</Text>
          <ChevronDown size={14} aria-hidden="true" />
        </HStack>
      </Button>
    </Popover>
  );
}
