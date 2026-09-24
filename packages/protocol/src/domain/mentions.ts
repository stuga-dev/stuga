/**
 * @mentions. A comment is plain text, so it names people as `@username`, and
 * the node resolves those to members when the comment is saved. A document
 * holds a `mention` node carrying the alias, which Markdown spells
 * `[@label](mention:<alias>)` so an agent's rewrite keeps it.
 */

/** The most people one comment or one save of a document notifies. */
export const MAX_MENTIONS = 20;

export const MENTION_HREF_PREFIX = "mention:";

/** One resolved `@username` in a comment. */
export interface CommentMention {
  alias: string;
  username: string;
}

/**
 * `@` preceded by the start, whitespace or opening punctuation, so `ada@example.com`
 * is not a mention. A username may contain dots, so a sentence's closing dot is
 * tried both ways by the caller.
 */
const COMMENT_MENTION = /(^|[\s([{"'“‘])@([a-z0-9][a-z0-9._-]{1,31})/gi;

/**
 * The usernames a comment might name, lowercased and unique, in order. `@ada.`
 * also offers `ada`, since the node cannot tell a trailing dot from a username's
 * own until it looks.
 */
export function commentMentionCandidates(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(COMMENT_MENTION)) {
    const raw = m[2]!.toLowerCase();
    out.add(raw);
    const trimmed = raw.replace(/[._-]+$/, "");
    if (trimmed.length >= 2) out.add(trimmed);
    if (out.size >= MAX_MENTIONS * 2) break;
  }
  return [...out];
}

/** A comment body cut into text and the mentions it resolved to, for rendering. */
export type CommentSegment = { text: string } | { text: string; mention: CommentMention };

export function commentSegments(body: string, mentions: readonly CommentMention[]): CommentSegment[] {
  if (mentions.length === 0) return [{ text: body }];
  const byUsername = new Map(mentions.map((m) => [m.username, m]));
  const out: CommentSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(COMMENT_MENTION)) {
    const lead = m[1]!;
    let name = m[2]!.toLowerCase();
    // The longest username that resolved wins, so `@ada.` renders `@ada` and a dot.
    while (!byUsername.has(name) && /[._-]$/.test(name)) name = name.slice(0, -1);
    const mention = byUsername.get(name);
    if (!mention) continue;
    const start = m.index! + lead.length;
    const end = start + 1 + name.length;
    if (start > last) out.push({ text: body.slice(last, start) });
    out.push({ text: body.slice(start, end), mention });
    last = end;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}

/** A document mention's link target. The alias is encoded: an identity provider's subject may hold any character. */
export function mentionHref(alias: string): string {
  return MENTION_HREF_PREFIX + encodeURIComponent(alias);
}

/** The alias a `mention:` target names, or null for any other link or a malformed one. */
export function aliasFromMentionHref(href: string | null | undefined): string | null {
  if (!href?.startsWith(MENTION_HREF_PREFIX)) return null;
  try {
    const alias = decodeURIComponent(href.slice(MENTION_HREF_PREFIX.length));
    return alias.trim() ? alias : null;
  } catch {
    return null;
  }
}

/** The people a document's Markdown mentions, unique, in order of first appearance. */
export function markdownMentionAliases(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\]\((mention:[^)\s]+)\)/g)) {
    const alias = aliasFromMentionHref(m[1]);
    if (alias) out.add(alias);
  }
  return [...out];
}
