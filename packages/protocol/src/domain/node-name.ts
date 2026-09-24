/**
 * What a node is called, and the one name every MCP client stores this product
 * under. A client holds one Stuga connection: the node it is connected to lists
 * the workspaces it can reach, each naming the node it lives on, so telling
 * nodes apart is the listing's job, never the connection's name.
 */

/** Longest node name. Mirrored by a CHECK in 0001. */
export const MAX_NODE_NAME_CHARS = 80;

/** The config key every client stores this connection under. */
export const MCP_SERVER_KEY = "stuga";
/** The name a client shows for it. */
export const MCP_SERVER_TITLE = "Stuga";
/** The Claude Desktop extension's download. */
export const MCP_BUNDLE_FILENAME = `${MCP_SERVER_KEY}.mcpb`;

/**
 * What a name or label a person types may not hold: control characters, the
 * line and paragraph separators, and the invisible direction marks that can make
 * text read as something else. Other format characters stay, because names use
 * them: the joiner inside an emoji sequence, the non-joiner Persian spelling
 * needs, a soft hyphen.
 */
export const UNSAFE_TEXT = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029]/u;

/** One character that shows: not space, not a format or ignorable character, not a mark with nothing to sit on, not a blank glyph. */
const VISIBLE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{M}\u2800]/u;

/** Whether a name or label shows anything at all: one made only of invisible characters reads as blank. */
export function hasVisibleText(text: string): boolean {
  return VISIBLE.test(text);
}

/**
 * What a node nobody has named goes by wherever nodes are told apart: the host
 * people reach it at, without the port and without mDNS's `.local`, neither of
 * which says which machine it is. `http://livs-air.local:8787` → `livs-air`.
 */
export function hostLabel(origin: string): string {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return origin;
  }
  return hostname.replace(/\.local$/i, "") || hostname;
}
