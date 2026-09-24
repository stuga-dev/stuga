/** An item header's title: click to rename, Enter or blur to commit; a refused rename says why and snaps back. */
import { useState } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Docs } from "../api";
import { errorMessage } from "../lib/http/client";

interface TitleRename {
  title: string;
  setTitle: (title: string) => void;
  editing: boolean;
  startEditing: () => void;
  commit: () => Promise<void>;
}

/** Shows `serverTitle` as it changes, except over a title being typed or one this page renamed to. */
export function useTitleRename(docId: string, serverTitle: string, readOnly: boolean, onError?: (e: unknown) => void): TitleRename {
  /** What is being typed; null while not editing. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Outranks `serverTitle` until the rename is refused. */
  const [renamed, setRenamed] = useState<string | null>(null);
  const toast = useToast();
  const current = renamed ?? (serverTitle || "Untitled");

  async function commit() {
    if (draft === null) return;
    setDraft(null);
    const next = draft.trim();
    // Unchanged is not sent: any rename latches title_source='user' and stops heading sync for good.
    if (next === current || !next || readOnly) return;
    const before = renamed;
    setRenamed(next);
    try {
      await Docs.rename(docId, next);
    } catch (e) {
      onError?.(e);
      toast({ body: errorMessage(e, "Couldn’t rename it."), type: "error" });
      setRenamed(before);
    }
  }

  return {
    title: draft ?? current,
    setTitle: setDraft,
    editing: draft !== null,
    startEditing: () => setDraft(current),
    commit,
  };
}

export function ItemTitle({ rename, readOnly, label }: { rename: TitleRename; readOnly: boolean; label: string }) {
  if (rename.editing) {
    return (
      <TextInput
        label={label}
        isLabelHidden
        value={rename.title}
        onChange={rename.setTitle}
        hasAutoFocus
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
      title={readOnly ? rename.title : "Click to rename"}
    >
      <Text type="large" weight="semibold" maxLines={1}>
        {rename.title}
      </Text>
    </button>
  );
}
