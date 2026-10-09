/** The people an @query matches, as a listbox. Positioning is the caller's. */
import type { UserInfo } from "../api";
import { t } from "../i18n/i18n";
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
      ? t("document.mentions.typeName")
      : people.length === 0
        ? loading
          ? t("document.mentions.searching")
          : t("document.mentions.noMatch", { query: query.trim() })
        : null;
  return (
    <div className={`mention-list${className ? ` ${className}` : ""}`} style={style} role="listbox" aria-label={t("document.mentions.label")}>
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
          {/* i18n-exempt: a principal id */}
          <Avatar principal={`user:${u.alias}`} size={20} />
          <span className="mention-item__name">{u.display_name || u.username || u.email || u.alias}</span>
          {u.username && <span className="mention-item__handle">@{u.username}</span>}
        </button>
      ))}
    </div>
  );
}
