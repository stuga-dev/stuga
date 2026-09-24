/** Labels for the "default access for new documents and folders" choice; the values are the protocol's. */
import { DOC_ACCESS_MODES, type DocAccessMode } from "@stuga/protocol/domain/workspaces";

/** A Record, so a new protocol mode fails to compile until it has a label. */
const ACCESS_LABEL: Record<DocAccessMode, string> = {
  workspace_edit: "Everyone can edit",
  workspace_view: "Everyone can view",
  private: "Private to creator",
};

/** Mutable, since Selector's `options` does not accept a readonly array. */
export const WORKSPACE_ACCESS_OPTIONS: Array<{ value: DocAccessMode; label: string }> =
  DOC_ACCESS_MODES.map((value) => ({ value, label: ACCESS_LABEL[value] }));

/** Shown where a workspace is created. */
export const WORKSPACE_ACCESS_HELP =
  "This applies to new documents and folders. You can change each item’s sharing later.";
