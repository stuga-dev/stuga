/** The people an @query matches, as a listbox. Positioning is the caller's. */
import type { UserInfo } from "../api";
import { Avatar } from "../state/identity";
import { MIN_MENTION_QUERY } from "./mention-query";

export function MentionList({
  query,
  people,
  loading,
  active,
  onActive,
  onChoose,
  className,
  style,
}: {
  query: string;
  people: UserInfo[];
  loading: boolean;
  active: number;
  onActive: (i: number) => void;
  onChoose: (u: UserInfo) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const hint =
    query.trim().length < MIN_MENTION_QUERY
      ? "Type a name or username"
      : people.length === 0
        ? loading
          ? "Searching…"
          : `No one matches “${query.trim()}”`
        : null;
  return (
    <div className={`mention-list${className ? ` ${className}` : ""}`} style={style} role="listbox" aria-label="Mention someone">
      {hint && (
        <div className="mention-item mention-item--empty" role="presentation">
          {hint}
        </div>
      )}
      {people.map((u, i) => (
        <button
          key={u.alias}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`mention-item${i === active ? " active" : ""}`}
          // Keep focus, and the caret, in the text being typed.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onActive(i)}
          onClick={() => onChoose(u)}
        >
          <Avatar principal={`user:${u.alias}`} size={20} />
          <span className="mention-item__name">{u.display_name || u.username || u.email || u.alias}</span>
          {u.username && <span className="mention-item__handle">@{u.username}</span>}
        </button>
      ))}
    </div>
  );
}
