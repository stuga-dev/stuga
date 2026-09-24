/** The palette's open flag, above both the palette and the page control that opens it. */
import { createContext, useCallback, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

interface CommandPaletteControl {
  isOpen: boolean;
  /** Idempotent, unlike the shortcut's toggle: a click on "Search documents" never closes it. */
  open: () => void;
  /** For the shortcut and the dialog's own close. */
  setOpen: Dispatch<SetStateAction<boolean>>;
}

const Ctx = createContext<CommandPaletteControl | null>(null);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  // Stable, so effects can depend on `open` without re-running on every toggle.
  const open = useCallback(() => setOpen(true), []);
  const value = useMemo<CommandPaletteControl>(() => ({ isOpen, open, setOpen }), [isOpen, open]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Throws outside the provider rather than giving a search control that does nothing. */
export function useCommandPalette(): CommandPaletteControl {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCommandPalette() requires <CommandPaletteProvider>");
  return ctx;
}
