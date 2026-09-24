/** The live Tiptap editor, shared with the panels that read its selection. */
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";

interface EditorCtx {
  editor: Editor | null;
  setEditor: (e: Editor | null) => void;
}

const Ctx = createContext<EditorCtx>({ editor: null, setEditor: () => {} });

export function EditorProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  return <Ctx.Provider value={{ editor, setEditor }}>{children}</Ctx.Provider>;
}

export function useSharedEditor(): EditorCtx {
  return useContext(Ctx);
}
