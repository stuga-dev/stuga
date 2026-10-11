/** Labels for the "access for new documents" choice; the values are the protocol's. */
import { DOC_ACCESS_MODES, type DocAccessMode } from "@stuga/protocol/domain/workspaces";
import { t, type MessageKey } from "../i18n/i18n";

/** A Record, so a new protocol mode fails to compile until it has a label. */
const ACCESS_LABEL: Record<DocAccessMode, MessageKey> = {
  workspace_edit: "shell.workspaceAccess.workspaceEdit",
  workspace_view: "shell.workspaceAccess.workspaceView",
  private: "shell.workspaceAccess.private",
};

/** Mutable, since Selector's `options` does not accept a readonly array. */
export const WORKSPACE_ACCESS_OPTIONS: Array<{ value: DocAccessMode; label: string }> =
  DOC_ACCESS_MODES.map((value) => ({ value, label: t(ACCESS_LABEL[value]) }));

/** The choice's one name, where a workspace is created and in its settings. */
export const WORKSPACE_ACCESS_LABEL = t("shell.workspaceAccess.label");

export const WORKSPACE_ACCESS_HELP = t("shell.workspaceAccess.help");
