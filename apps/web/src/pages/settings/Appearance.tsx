/** The theme: light, dark, or following the device. Stored per browser. */
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { PageColumn } from "../../ui/PageColumn";
import { useThemePreference, setThemePreference, type ThemePreference } from "../../state/theme";

export function Appearance() {
  const themePref = useThemePreference();
  return (
    <PageColumn>
      <VStack gap={3}>
        <Heading level={2}>Appearance</Heading>
        <HStack gap={3} vAlign="center" justify="between">
          <Text size="sm" color="secondary">
            System follows this device. Your choice is saved only in this browser.
          </Text>
          <SegmentedControl
            label="Theme"
            value={themePref}
            onChange={(v) => setThemePreference(v as ThemePreference)}
          >
            <SegmentedControlItem value="system" label="System" />
            <SegmentedControlItem value="light" label="Light" />
            <SegmentedControlItem value="dark" label="Dark" />
          </SegmentedControl>
        </HStack>
      </VStack>
    </PageColumn>
  );
}
