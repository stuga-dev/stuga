/**
 * State chips beside an open item's title. Not interactive: unlocking for
 * everyone should take more than one click, so the tooltips point to the ⋯ menu.
 */
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { HStack } from "@astryxdesign/core/HStack";
import { Eye } from "lucide-react";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { DOC_STATE_FLAGS, docStateOf } from "./doc-state";
import { t } from "../i18n/i18n";

export function DocStateChips({
  locked,
  searchHidden,
  agentMode,
  readOnly,
  noun = "document",
}: {
  locked: boolean;
  searchHidden: boolean;
  /** How AI edits to it are reviewed: a chip shows a level other than the default. */
  agentMode: ReviewMode;
  /** The caller lacks edit access, independent of the lock. */
  readOnly: boolean;
  noun?: "document" | "database";
}) {
  const state = docStateOf({ locked, search_hidden: searchHidden, agent_mode: agentMode });
  const on = DOC_STATE_FLAGS.filter((f) => f.isOn(state));
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
        <Tooltip content={t("library.state.viewOnlyTooltip", { noun })} placement="below">
          <Token size="sm" color="yellow" icon={<Eye size={12} />} label={t("library.state.viewOnly")} />
        </Tooltip>
      )}
    </HStack>
  );
}
