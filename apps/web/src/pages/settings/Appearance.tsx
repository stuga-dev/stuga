/**
 * The theme, stored per browser, and the interface language, stored on the account. Both can
 * follow the device.
 */
import { useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "../../ui/use-toast";
import { UI_LANGUAGE_NAMES, UI_LANGUAGES, isUiLanguage } from "@stuga/protocol/domain/ui-languages";
import { PageColumn } from "../../ui/PageColumn";
import { SettingsTitle } from "./SettingsTitle";
import { useThemePreference, setThemePreference, type ThemePreference } from "../../state/theme";
import { t } from "../../i18n/i18n";
import { cachedLanguageChoice } from "../../i18n/choice-cache";
import { browserUiLanguage, chooseLanguage } from "../../i18n/preference";
import { errorMessage } from "../../lib/http/client";

const SYSTEM = "system";

export function Appearance() {
  const themePref = useThemePreference();
  const toast = useToast();
  const [language, setLanguage] = useState<string>(cachedLanguageChoice() ?? SYSTEM);
  const [saving, setSaving] = useState(false);

  async function pick(value: string) {
    const choice = isUiLanguage(value) ? value : null;
    setLanguage(value);
    setSaving(true);
    try {
      await chooseLanguage(choice);
    } catch (e) {
      setLanguage(cachedLanguageChoice() ?? SYSTEM);
      setSaving(false);
      toast({ body: errorMessage(e, t("settings.appearance.languageFailed")), type: "error" });
    }
  }

  return (
    <PageColumn>
      <VStack gap={5}>
        <SettingsTitle>{t("settings.appearance.heading")}</SettingsTitle>
        <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
          <SettingName name={t("settings.appearance.theme")} note={t("settings.appearance.themeNote")} />
          <SegmentedControl label={t("settings.appearance.theme")} value={themePref} onChange={(v) => setThemePreference(v as ThemePreference)}>
            <SegmentedControlItem value="system" label={t("settings.appearance.system")} />
            <SegmentedControlItem value="light" label={t("settings.appearance.light")} />
            <SegmentedControlItem value="dark" label={t("settings.appearance.dark")} />
          </SegmentedControl>
        </HStack>
        <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
          <SettingName name={t("settings.appearance.language")} note={t("settings.appearance.languageNote")} />
          {/* The visible label is the text beside it. */}
          <Selector
            label={t("settings.appearance.language")}
            isLabelHidden
            value={language}
            isDisabled={saving}
            onChange={(v) => void pick(v)}
            options={[
              { value: SYSTEM, label: t("settings.appearance.languageSystem", { language: UI_LANGUAGE_NAMES[browserUiLanguage()] }) },
              { type: "divider" },
              ...UI_LANGUAGES.map((l) => ({ value: l, label: UI_LANGUAGE_NAMES[l] })),
            ]}
          />
        </HStack>
      </VStack>
    </PageColumn>
  );
}

/** A setting's visible name, which its control also carries as its accessible name, and what it does. */
function SettingName({ name, note }: { name: string; note: string }) {
  return (
    <VStack gap={0.5}>
      <Text weight="semibold">{name}</Text>
      <Text size="sm" color="secondary">
        {note}
      </Text>
    </VStack>
  );
}
