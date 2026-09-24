/** Values of `workspaces.default_doc_access`; the web app owns the labels. */
export const DOC_ACCESS_MODES = ["workspace_edit", "workspace_view", "private"] as const;

export type DocAccessMode = (typeof DOC_ACCESS_MODES)[number];

/**
 * What a create form preselects. It matches the column DEFAULT, which stays the
 * authority for a request that omits the field.
 */
export const DEFAULT_DOC_ACCESS: DocAccessMode = "workspace_edit";

export function isDocAccessMode(value: unknown): value is DocAccessMode {
  return typeof value === "string" && (DOC_ACCESS_MODES as readonly string[]).includes(value);
}
