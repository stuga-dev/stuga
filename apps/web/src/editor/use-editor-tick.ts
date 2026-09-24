/** Re-renders the caller on every editor transaction, for controls outside the editor's own component. */
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";

export function useEditorTick(editor: Editor | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const bump = () => setTick((t) => t + 1);
    editor.on("transaction", bump);
    editor.on("selectionUpdate", bump);
    return () => {
      editor.off("transaction", bump);
      editor.off("selectionUpdate", bump);
    };
  }, [editor]);
}
