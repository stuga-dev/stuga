import { useCallback, useState, type ReactNode } from "react";
import { BotMessageSquare } from "lucide-react";
import { InstructionsDialog, type InstructionsTarget } from "./InstructionsDialog";

/**
 * "Instructions for agents…" for any menu: `item` is the menu entry for one
 * item and `dialog` is rendered once beside the menu. The last target is kept
 * after closing so the dialog does not go blank while it animates out.
 */
export function useInstructionsDialog(): {
  item: (target: InstructionsTarget) => { label: string; icon: ReactNode; onClick: () => void };
  dialog: ReactNode;
} {
  const [target, setTarget] = useState<InstructionsTarget | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const item = useCallback(
    (next: InstructionsTarget) => ({
      label: "Instructions for agents…",
      icon: <BotMessageSquare size={15} />,
      onClick: () => {
        setTarget(next);
        setIsOpen(true);
      },
    }),
    [],
  );

  const dialog = target && <InstructionsDialog isOpen={isOpen} target={target} onClose={() => setIsOpen(false)} />;

  return { item, dialog };
}
