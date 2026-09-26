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

/**
 * Sample agent, the agent with no key that proposes a sample workspace's changes for the person who
 * made it to review. Its alias is a word, where a minted agent's is `agent-` and random characters.
 */
export const SAMPLE_AGENT_ALIAS = "agent-sample";
export const SAMPLE_AGENT_NAME = "Sample agent";

/**
 * How long the node spends on one workspace import or export before it stops: less than the hour
 * the web app waits for either, so the person hears why.
 */
export const ARCHIVE_WORK_MAX_MS = 50 * 60_000;
