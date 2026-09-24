/**
 * The `@query` a caret sits at the end of, shared by the comment box and the
 * editor. A query may hold one space, so "@Ada Lo" can find Ada Lovelace; the
 * caller closes the list once a spaced query matches no one, so ordinary prose
 * after an `@` does not keep it open.
 */
const QUERY = /(^|[\s([{"'“‘])@([^\s@]{0,32}(?: [^\s@]{0,32})?)$/u;

export interface MentionQuery {
  /** Offset of the `@` in the text given. */
  start: number;
  query: string;
}

export function mentionQueryAt(textBeforeCaret: string): MentionQuery | null {
  const m = QUERY.exec(textBeforeCaret);
  if (!m) return null;
  return { start: m.index + m[1]!.length, query: m[2]! };
}

/** The server searches from two characters, so one keystroke cannot list the directory. */
export const MIN_MENTION_QUERY = 2;
