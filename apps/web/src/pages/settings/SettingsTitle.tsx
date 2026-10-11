/**
 * A settings page's title: the library's title size, so the page's own sections (h2) sit under it.
 * Every settings page starts with one, in the same place.
 */
import type { ReactNode } from "react";
import { Heading } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";

export function SettingsTitle({ children, endContent }: { children: string; endContent?: ReactNode }) {
  const title = <Heading level={1}>{children}</Heading>;
  if (!endContent) return title;
  return (
    <HStack justify="between" vAlign="center" gap={3}>
      {title}
      {endContent}
    </HStack>
  );
}
