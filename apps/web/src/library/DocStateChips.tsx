/**
 * State chips beside an open item's title. Not interactive: unlocking for
 * everyone should take more than one click, so the tooltips point to the ⋯ menu.
 */
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { HStack } from "@astryxdesign/core/HStack";
import { Eye } from "lucide-react";
import { DOC_STATE_FLAGS } from "./doc-state";

export function DocStateChips({
  locked,
  searchHidden,
  agentAuto,
  readOnly,
  noun = "document",
}: {
  locked: boolean;
  searchHidden: boolean;
  agentAuto: boolean;
  /** The caller lacks edit access, independent of the lock. */
  readOnly: boolean;
  noun?: "document" | "database";
}) {
  const on = DOC_STATE_FLAGS.filter((f) => f.isOn({ locked, searchHidden, agentAuto }));
  const viewOnly = readOnly && !locked;
  if (on.length === 0 && !viewOnly) return null;
  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      {on.map(({ label, icon: Icon, chip, tooltip }) => (
        <Tooltip key={label} content={tooltip(noun)} placement="below">
          <Token size="sm" color={chip} icon={<Icon size={12} />} label={label} />
        </Tooltip>
      ))}
      {viewOnly && (
        <Tooltip content={`You don’t have edit access to this ${noun}.`} placement="below">
          <Token size="sm" color="yellow" icon={<Eye size={12} />} label="View only" />
        </Tooltip>
      )}
    </HStack>
  );
}
