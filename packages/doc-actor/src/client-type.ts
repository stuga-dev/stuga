/**
 * Client-type buckets for connection metrics. The `?agent=` label is
 * client-chosen, so it collapses to a fixed allowlist instead of becoming an
 * unbounded metric dimension.
 */

/** The fixed, bounded set of client-type buckets a connection can map to. */
export type ClientType = "browser" | "claude" | "cursor" | "copilot" | "kiro" | "mcp" | "other";

/** All buckets, for zero-filling a breakdown so absent types read as 0, not missing. */
export const CLIENT_TYPES: readonly ClientType[] = [
  "browser",
  "claude",
  "cursor",
  "copilot",
  "kiro",
  "mcp",
  "other",
] as const;

/** No label is a browser tab; a known family matches case-insensitively as a substring ("claude-code", "Cursor 0.4"); anything else is "other". */
export function bucketClientType(agent?: string | null): ClientType {
  if (!agent) return "browser";
  const a = agent.toLowerCase();
  if (a.includes("claude")) return "claude";
  if (a.includes("cursor")) return "cursor";
  if (a.includes("copilot")) return "copilot";
  if (a.includes("kiro")) return "kiro";
  if (a.includes("mcp")) return "mcp";
  return "other";
}
