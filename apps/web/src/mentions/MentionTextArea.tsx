/**
 * An Astryx TextArea that suggests people after `@` and inserts `@username`.
 * Comments are plain text, so the username is the whole mention; the node
 * resolves it when the comment is saved.
 */
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { TextArea } from "@astryxdesign/core/TextArea";
import type { UserInfo } from "../api";
import { MentionList } from "./MentionList";
import { mentionQueryAt } from "./mention-query";
import { usePeopleSearch } from "./use-people-search";

type TextAreaProps = ComponentProps<typeof TextArea>;

export function MentionTextArea({
  value,
  onChange,
  onKeyDown,
  placement = "below",
  ...rest
}: Omit<TextAreaProps, "value" | "onChange" | "onKeyDown" | "ref"> & {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Where the list opens: below the box, or above it when the box sits at the bottom of a panel. */
  placement?: "below" | "above";
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  /** The `@` offset the person dismissed with Escape; typing a new `@` reopens. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  /** Where the caret goes once an inserted mention has rendered. */
  const pendingCaret = useRef<number | null>(null);

  // Before paint and before the next keystroke: a caret restored a frame later lands keys typed in between at the wrong place.
  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    const el = ref.current;
    if (pos === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [value]);

  const at = mentionQueryAt(value.slice(0, Math.min(caret, value.length)));
  const { people, loading } = usePeopleSearch(at && focused ? at.query : null);
  const open =
    at !== null &&
    focused &&
    dismissedAt !== at.start &&
    // A spaced query that matches no one is prose, not a name.
    !(at.query.includes(" ") && !loading && people.length === 0);

  const syncCaret = () => {
    const el = ref.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  function choose(u: UserInfo) {
    if (!at || !u.username) return;
    const insert = `@${u.username} `;
    const next = value.slice(0, at.start) + insert + value.slice(caret);
    const pos = at.start + insert.length;
    pendingCaret.current = pos;
    onChange(next);
    setCaret(pos);
    setActive(0);
  }

  return (
    <div className={`mention-textarea mention-textarea--${placement}`}>
      <TextArea
        {...rest}
        ref={ref}
        value={value}
        onChange={(v: string) => {
          onChange(v);
          setActive(0);
          // The input event has already moved the DOM caret.
          syncCaret();
        }}
        onFocus={() => {
          setFocused(true);
          syncCaret();
        }}
        onBlur={() => setFocused(false)}
        onSelect={syncCaret}
        onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = people.length;
              if (n) setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && people.length > 0) {
              e.preventDefault();
              choose(people[Math.min(active, people.length - 1)]!);
              return;
            }
            if (e.key === "Escape") {
              // Closes the list only; a second Escape reaches the composer.
              e.preventDefault();
              e.stopPropagation();
              setDismissedAt(at!.start);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {open && (
        <MentionList
          className="mention-list--attached"
          query={at!.query}
          people={people}
          loading={loading}
          active={Math.min(active, Math.max(people.length - 1, 0))}
          onActive={setActive}
          onChoose={choose}
        />
      )}
    </div>
  );
}
