import { useState } from "react";
import { Heading, Text } from "@astryxdesign/core/Text";
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

export function BrandingSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (ops: NodeOperationalSettings) => void }) {
  const status = useSectionStatus();
  const [opsForm, setOpsForm] = useState<OpsForm>(() => toOpsForm(ops));
  const [busy, setBusy] = useState(false);

  /** Emptied, the app goes back to the product's name; anything typed is checked as it is typed. */
  const name = opsForm.nodeName.trim();
  const nameProblem = name ? plainTextProblem(name, MAX_NODE_NAME_CHARS) : null;

  async function save() {
    if (nameProblem || busy) return;
    setBusy(true);
    status.clear();
    try {
      const res = await NodeApi.saveSettings({ node_name: name, branding: { accent_color: opsForm.brandAccentColor.trim() } });
      updateBranding({
        node: { name: res.node_name, label: res.node_label },
        branding: { accentColor: res.branding.accent_color },
      });
      onSaved(res);
      setOpsForm(toOpsForm(res));
      status.setNotice({ status: "success", message: "Saved — live now, no restart." });
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
        <Heading level={2}>Branding</Heading>
        <Text type="supporting" color="secondary">
          Set the node name and selection color.
        </Text>

        <VStack gap={1}>
          <TextInput
            label="Name"
            value={opsForm.nodeName}
            placeholder={PRODUCT_NAME}
            onChange={(nodeName) => setOpsForm({ ...opsForm, nodeName })}
            onEnter={() => void save()}
            {...(nameProblem ? { status: { type: "error" as const, message: nameProblem } } : {})}
          />
          <Text type="supporting" color="secondary">
            Shown in navigation, sign-in and agent tools.
          </Text>
        </VStack>

        <VStack gap={1}>
          <Text type="supporting" weight="medium">Brand color</Text>
          <Text type="supporting" color="secondary">
            Marks the current sidebar item and selected rows.
          </Text>
          <HStack gap={2} vAlign="center">
            <input
              type="color"
              value={opsForm.brandAccentColor || "#262626"}
              onChange={(e) => setOpsForm({ ...opsForm, brandAccentColor: e.target.value })}
              style={{ width: 40, height: 32, padding: 0, border: "1px solid var(--color-border)", borderRadius: "var(--radius-element)" }}
            />
            {opsForm.brandAccentColor && (
              <Button
                label="Reset to default"
                variant="ghost"
                size="sm"
                onClick={() => setOpsForm({ ...opsForm, brandAccentColor: "" })}
              />
            )}
          </HStack>
        </VStack>

        <BrandingPreview accentColor={opsForm.brandAccentColor} nodeName={name} />

        <HStack gap={2} vAlign="center">
          <Button
            label="Save"
            variant="primary"
            size="sm"
            isDisabled={nameProblem !== null}
            isLoading={busy}
            onClick={() => void save()}
          />
        </HStack>
      </VStack>
    </>
  );
}
