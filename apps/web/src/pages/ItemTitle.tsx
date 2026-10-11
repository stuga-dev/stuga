/** An item header's title: click to rename, Enter or blur to commit; a refused rename says why and snaps back. */
import { useEffect, useRef, useState } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "../ui/use-toast";
import { Docs, type DocSummary } from "../api";
import { errorMessage } from "../lib/http/client";
import { selectOnFocus } from "../ui/select-on-focus";
import { t } from "../i18n/i18n";

/** How long after renaming someone else's rename reads as one that won over it. */
const RACE_MS = 30_000;

interface TitleRename {
  /** What the field shows: the draft while editing, else `name`. */
  title: string;
  /** The item's name as it stands, "Untitled" while it has none. */
  name: string;
  /** The item has no title of its own, so `title` is the "Untitled" stand-in. */
  isUntitled: boolean;
  setTitle: (title: string) => void;
  editing: boolean;
  startEditing: () => void;
  commit: () => Promise<void>;
  /**
   * A read asked for at `askedAt` found the title is `title`, `by`'s choice: if that read came after
   * this page's own rename just now was answered, the other rename won over it, and the toast says so.
   */
  noteRenamedBy: (title: string, by: string, askedAt: number) => void;
}

/**
 * Shows `serverTitle` as it changes, except over a title being typed, or one
 * this page renamed to until the server's title moves. `onRenamed` gets the
 * row the rename answered with, and when the rename was sent: a title that
 * arrived after that is newer than the answer's.
 */
export function useTitleRename(
  docId: string,
  serverTitle: string,
  readOnly: boolean,
  onError?: (e: unknown) => void,
  onRenamed?: (doc: DocSummary, sentAt: number) => void,
): TitleRename {
  /** What is being typed; null while not editing. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Outranks `serverTitle` until the rename is refused or the server's title moves on. */
  const [renamed, setRenamed] = useState<string | null>(null);
  /** This page's last rename: when it was sent, and when the node answered it. */
  const lastRename = useRef<{ title: string; at: number; answeredAt: number | null } | null>(null);
  const toast = useToast();
  /** The stored title, empty while the item has none; "Untitled" is only how that reads. */
  const stored = renamed ?? serverTitle;
  const current = stored || t("common.untitled");

  // A new title from the server is the one everyone sees, this page's own rename included.
  useEffect(() => {
    setRenamed(null);
  }, [serverTitle]);

  async function commit() {
    if (draft === null) return;
    setDraft(null);
    const next = draft.trim();
    // Unchanged is not sent: any rename latches title_source='user' and stops heading sync for good.
    if (next === stored || !next || readOnly) return;
    const before = renamed;
    setRenamed(next);
    const sentAt = Date.now();
    const mine = { title: next, at: sentAt, answeredAt: null as number | null };
    lastRename.current = mine;
    try {
      const doc = await Docs.rename(docId, next);
      mine.answeredAt = Date.now();
      onRenamed?.(doc, sentAt);
    } catch (e) {
      lastRename.current = null;
      onError?.(e);
      toast({ body: errorMessage(e, t("pages.itemTitle.renameFailed")), type: "error" });
      setRenamed(before);
    }
  }

  function noteRenamedBy(title: string, by: string, askedAt: number) {
    const mine = lastRename.current;
    // A read asked before the answer may predate this page's own rename, which may still win.
    if (!mine || mine.answeredAt === null || askedAt < mine.answeredAt) return;
    if (Date.now() - mine.at > RACE_MS || mine.title === title) return;
    lastRename.current = null;
    toast({ body: t("pages.itemTitle.renamedBy", { name: by, title }), type: "info" });
  }

  return {
    title: draft ?? current,
    name: current,
    isUntitled: !stored,
    setTitle: setDraft,
    editing: draft !== null,
    // An untitled item opens empty, so typing never lands after a placeholder word.
    startEditing: () => setDraft(stored),
    commit,
    noteRenamedBy,
  };
}

/**
 * The page's heading: the item's name, which a click renames. `hint`: what the title says on hover
 * where clicking renames it; "Click to rename" when not given.
 */
export function ItemTitle({ rename, readOnly, label, hint }: { rename: TitleRename; readOnly: boolean; label: string; hint?: string }) {
  return (
    <h1 className="item-title">
      <ItemTitleField rename={rename} readOnly={readOnly} label={label} hint={hint} />
    </h1>
  );
}

function ItemTitleField({ rename, readOnly, label, hint }: { rename: TitleRename; readOnly: boolean; label: string; hint?: string }) {
  if (rename.editing) {
    return (
      <TextInput
        label={label}
        isLabelHidden
        value={rename.title}
        onChange={rename.setTitle}
        placeholder={t("common.untitled")}
        hasAutoFocus
        onFocus={selectOnFocus}
        onEnter={rename.commit}
        onBlur={rename.commit}
      />
    );
  }
  return (
    <button
      className="doc-title-btn"
      onClick={() => !readOnly && rename.startEditing()}
      disabled={readOnly}
      title={readOnly ? rename.title : (hint ?? t("pages.itemTitle.clickToRename"))}
    >
      <Text type="large" weight="semibold" maxLines={1} className="bidi-line" color={rename.isUntitled ? "secondary" : undefined}>
        {rename.title}
      </Text>
    </button>
  );
}
