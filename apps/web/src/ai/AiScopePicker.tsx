import type { ReactNode } from "react";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Files, Library } from "lucide-react";
import { ALL_DOCUMENTS_SCOPE } from "@stuga/protocol/wire/doc-socket";
import { useModelOptions } from "../state/model-options";
import { useCollections } from "./use-collections";

/**
 * Model and search-scope pickers above an AI composer. `scope` null means the
 * turn uses only the item on screen, which `base` names.
 */
export function AiScopePicker({
  model,
  onModelChange,
  scope,
  onScopeChange,
  base,
}: {
  model: string;
  onModelChange: (model: string) => void;
  scope: string | null;
  onScopeChange: (scope: string | null) => void;
  base: { label: string; icon: ReactNode };
}) {
  const modelOptions = useModelOptions();
  const { collections } = useCollections();
  const scopeOptions = [
    { value: "", label: base.label, icon: base.icon },
    { value: ALL_DOCUMENTS_SCOPE, label: "All documents in this workspace", icon: <Files size={15} /> },
    ...(collections ?? []).map((c) => ({ value: c.collection_id, label: c.name, icon: <Library size={15} /> })),
  ];
  return (
    <HStack gap={2}>
      <div style={{ width: 110 }}>
        <Selector label="Model" isLabelHidden size="sm" value={model} onChange={onModelChange} options={modelOptions} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Selector
          label="Search scope"
          isLabelHidden
          size="sm"
          value={scope ?? ""}
          onChange={(v) => onScopeChange(v || null)}
          options={scopeOptions}
        />
      </div>
    </HStack>
  );
}
