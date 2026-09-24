/**
 * People menu, opened by typing `@` in the editor. Choosing someone replaces
 * the typed `@query` with a mention node; the node notifies them once the
 * document is saved and indexed.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { UserInfo } from "../../api";
import { MentionList } from "../../mentions/MentionList";
import { mentionQueryAt } from "../../mentions/mention-query";
import { usePeopleSearch } from "../../mentions/use-people-search";
import { useEditorAnchor } from "../use-editor-anchor";

interface MentionState {
  /** Doc position of the `@`. */
  from: number;
  /** Doc position of the caret (end of the query). */
  to: number;
  query: string;
  rect: { top: number; left: number };
}

export function MentionMenu({ editor }: { editor: Editor }) {
  const [active, setActive] = useState(0);
  // The capture-phase key handler is bound once, so it reads the latest values through refs.
  const stateRef = useRef<MentionState | null>(null);
  const activeRef = useRef(0);
  const peopleRef = useRef<UserInfo[]>([]);
  const openRef = useRef(false);
  /** The `@` position dismissed with Escape; a new `@` elsewhere reopens. */
  const dismissedRef = useRef<number | null>(null);

  const [state, hide] = useEditorAnchor(editor, (): MentionState | null => {
    const { state: s, view } = editor;
    const sel = s.selection;
    if (!sel.empty || !view.hasFocus() || !editor.isEditable) return null;
    const $from = sel.$from;
    if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
    if ($from.marks().some((m) => m.type.name === "code" || m.type.name === "link")) return null;
    const blockStart = $from.start();
    // One character per position: an atom or a hard break reads as a placeholder, never as part of a name.
    const before = s.doc.textBetween(blockStart, sel.from, "\n", "￼");
    const at = mentionQueryAt(before);
    if (!at) return null;
    const from = sel.from - (before.length - at.start);
    if (dismissedRef.current === from) return null;
    const coords = view.coordsAtPos(sel.from);
    if (stateRef.current?.from !== from || stateRef.current.query !== at.query) setActive(0);
    return { from, to: sel.from, query: at.query, rect: { top: coords.bottom, left: coords.left } };
  });

  const { people, loading } = usePeopleSearch(state ? state.query : null);
  // A spaced query that matches no one is prose, not a name.
  const open = state !== null && !(state.query.includes(" ") && !loading && people.length === 0);
  stateRef.current = state;
  activeRef.current = active;
  peopleRef.current = people;
  openRef.current = open;

  useEffect(() => {
    if (editor.isDestroyed) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      const st = stateRef.current;
      const list = peopleRef.current;
      if (!st || !openRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        dismissedRef.current = st.from;
        hide();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = list.length;
        if (n) setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && list.length > 0) {
        e.preventDefault();
        choose(list[Math.min(activeRef.current, list.length - 1)]!);
      }
    };
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  function choose(u: UserInfo) {
    const st = stateRef.current;
    if (!st) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: st.from, to: st.to }, [
        { type: "mention", attrs: { alias: u.alias, label: u.username ?? u.display_name ?? u.alias } },
        { type: "text", text: " " },
      ])
      .run();
    hide();
  }

  if (!state || !open) return null;
  // The list is about 260px wide and up to 300px tall.
  const left = Math.min(state.rect.left, window.innerWidth - 270);
  const top = Math.min(state.rect.top + 4, window.innerHeight - 300);
  return (
    <MentionList
      className="mention-list--floating"
      style={{ top, left }}
      query={state.query}
      people={people}
      loading={loading}
      active={Math.min(active, Math.max(people.length - 1, 0))}
      onActive={setActive}
      onChoose={choose}
    />
  );
}
