/**
 * The brand colour where it lands, and a primary button where it does not, in a
 * light and a dark card, since the colour is clamped per mode. Each card is its
 * own Astryx <Theme mode>: an inline color-scheme does not re-resolve the
 * theme's light-dark() tokens in every browser.
 */
import type { CSSProperties } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Files, Star } from "lucide-react";
import { brandColor } from "../../../state/branding";
import { Brand, PRODUCT_NAME } from "../../../shell/Brand";

/** `--brand` for a valid hex; anything else leaves the card's default marker. */
function cardVars(accentColor: string, mode: "light" | "dark"): CSSProperties {
  const brand = brandColor(accentColor, mode);
  return (brand ? { "--brand": brand } : {}) as CSSProperties;
}

export function BrandingPreview({
  accentColor,
  nodeName,
}: {
  /** The hex being edited. Anything that isn't `#rrggbb` previews the default. */
  accentColor: string;
  /** The name being edited, empty until the node has one; shown beside the mark as the top bar shows it. */
  nodeName: string;
}) {
  return (
    <VStack gap={1}>
      <Text type="supporting" weight="medium">Preview</Text>
      <HStack gap={2} wrap="wrap">
        <PreviewCard mode="light" accentColor={accentColor} nodeName={nodeName} />
        <PreviewCard mode="dark" accentColor={accentColor} nodeName={nodeName} />
      </HStack>
      {!brandColor(accentColor, "light") && (
        <Text type="supporting" color="secondary">No custom color — showing the default marker.</Text>
      )}
    </VStack>
  );
}

function PreviewCard({
  mode,
  accentColor,
  nodeName,
}: {
  mode: "light" | "dark";
  accentColor: string;
  nodeName: string;
}) {
  return (
    <Theme theme={neutralTheme} mode={mode}>
      <VStack gap={2} padding={3} className="brand-preview" style={cardVars(accentColor, mode)}>
      <Text type="supporting" color="secondary">{mode === "light" ? "Light" : "Dark"}</Text>

      {/* The header identity, monochrome whatever the brand colour. */}
      <HStack gap={2} vAlign="center">
        <Brand />
        <Text type="large" weight="semibold" maxLines={1}>{nodeName || PRODUCT_NAME}</Text>
      </HStack>

      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button label="New" variant="primary" size="sm" />
        <Button label="Share" variant="secondary" size="sm" />
      </HStack>

      <VStack gap={0} className="brand-preview__nav">
        <HStack className="brand-preview__nav-item brand-preview__nav-item--current" gap={2} paddingBlock={1} paddingInline={2} vAlign="center">
          <Files size={14} />
          <Text type="supporting" maxLines={1}>All documents</Text>
        </HStack>
        <HStack className="brand-preview__nav-item" gap={2} paddingBlock={1} paddingInline={2} vAlign="center">
          <Star size={14} />
          <Text type="supporting" color="secondary" maxLines={1}>Favorites</Text>
        </HStack>
      </VStack>

      {/* The selected row sits in the middle: the rounded block would clip a bar on the first or last. */}
      <VStack gap={0} className="brand-preview__rows">
        <HStack className="brand-preview__row" paddingBlock={1} paddingInline={2} vAlign="center">
          <Text type="supporting" color="secondary" maxLines={1}>A document</Text>
        </HStack>
        <HStack className="brand-preview__row brand-preview__row--selected" paddingBlock={1} paddingInline={2} vAlign="center">
          <Text type="supporting" maxLines={1}>Selected document</Text>
        </HStack>
        <HStack className="brand-preview__row" paddingBlock={1} paddingInline={2} vAlign="center">
          <Text type="supporting" color="secondary" maxLines={1}>Another document</Text>
        </HStack>
      </VStack>
      </VStack>
    </Theme>
  );
}
