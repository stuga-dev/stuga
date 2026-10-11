import { useState } from "react";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { MAX_NODE_NAME_CHARS } from "@stuga/protocol/domain/node-name";
import { NodeSettings as NodeApi, type NodeOperationalSettings } from "../../../api";
import { plainTextProblem } from "../../../lib/plain-text";
import { PRODUCT_NAME } from "../../../shell/Brand";
import { updateBranding } from "../../../state/branding";
import { BrandingPreview } from "./BrandingPreview";
import { toOpsForm, type OpsForm } from "./ops-form";
import { SectionStatusBanners, useSectionStatus } from "./status";
import { t } from "../../../i18n/i18n";

/** The colour the node takes: what its own check accepts. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** What the swatch shows while no colour is chosen. */
const DEFAULT_SWATCH = "#262626";

export function BrandingSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (ops: NodeOperationalSettings) => void }) {
  const status = useSectionStatus();
  const [opsForm, setOpsForm] = useState<OpsForm>(() => toOpsForm(ops));
  const [busy, setBusy] = useState(false);

  /** Emptied, the app goes back to the product's name; anything typed is checked as it is typed. */
  const name = opsForm.nodeName.trim();
  const nameProblem = name ? plainTextProblem(name, MAX_NODE_NAME_CHARS) : null;
  /** Emptied, the default marker; otherwise the 6-digit hex the node takes. */
  const color = opsForm.brandAccentColor.trim();
  const colorProblem = color && !HEX_COLOR.test(color) ? t("nodeAccess.branding.hexInvalid") : null;

  async function save() {
    if (nameProblem || colorProblem || busy) return;
    setBusy(true);
    status.clear();
    try {
      const res = await NodeApi.saveSettings({ node_name: name, branding: { accent_color: color } });
      updateBranding({
        node: { name: res.node_name, label: res.node_label },
        branding: { accentColor: res.branding.accent_color },
      });
      onSaved(res);
      setOpsForm(toOpsForm(res));
      status.setNotice({ status: "success", message: t("common.savedLive") });
    } catch (e) {
      status.fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionStatusBanners status={status} />
      <VStack gap={3}>
        <Text type="supporting" color="secondary">
          {t("nodeAccess.branding.intro")}
        </Text>

        <VStack gap={1}>
          <TextInput
            label={t("common.name")}
            value={opsForm.nodeName}
            placeholder={PRODUCT_NAME}
            onChange={(nodeName) => setOpsForm({ ...opsForm, nodeName })}
            onEnter={() => void save()}
            {...(nameProblem ? { status: { type: "error" as const, message: nameProblem } } : {})}
          />
          <Text type="supporting" color="secondary">
            {t("nodeAccess.branding.nameHelp")}
          </Text>
        </VStack>

        <VStack gap={1}>
          <Text type="supporting" weight="medium">{t("nodeAccess.branding.color")}</Text>
          <Text type="supporting" color="secondary">
            {t("nodeAccess.branding.colorHelp")}
          </Text>
          <HStack gap={2} vAlign="start">
            {/* The swatch picks; the field beside it shows the value and takes a pasted one. */}
            <input
              type="color"
              aria-label={t("nodeAccess.branding.color")}
              value={HEX_COLOR.test(color) ? color : DEFAULT_SWATCH}
              onChange={(e) => setOpsForm({ ...opsForm, brandAccentColor: e.target.value })}
              style={{ width: 40, height: 32, padding: 0, border: "1px solid var(--color-border)", borderRadius: "var(--radius-element)" }}
            />
            <TextInput
              label={t("nodeAccess.branding.hex")}
              isLabelHidden
              width={130}
              value={opsForm.brandAccentColor}
              placeholder={t("nodeAccess.branding.defaultColor")}
              onChange={(brandAccentColor) => setOpsForm({ ...opsForm, brandAccentColor })}
              onEnter={() => void save()}
              {...(colorProblem ? { status: { type: "error" as const, message: colorProblem } } : {})}
            />
            {opsForm.brandAccentColor && (
              <Button
                label={t("nodeAccess.branding.resetColor")}
                variant="ghost"
                size="sm"
                onClick={() => setOpsForm({ ...opsForm, brandAccentColor: "" })}
              />
            )}
          </HStack>
        </VStack>

        <BrandingPreview accentColor={colorProblem ? "" : color} nodeName={name} />

        <HStack gap={2} vAlign="center">
          <Button
            label={t("common.save")}
            variant="primary"
            size="sm"
            isDisabled={nameProblem !== null || colorProblem !== null}
            isLoading={busy}
            onClick={() => void save()}
          />
        </HStack>
      </VStack>
    </>
  );
}
