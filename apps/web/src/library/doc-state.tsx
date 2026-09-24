/**
 * A document's lock, search visibility and agent mode: the flags as the library
 * marks, badges and chips show them, and the menu items that change them. The
 * server allows the change only to the owner or a workspace admin, so the menu
 * applies it optimistically and rolls back on a refusal.
 */
import { useCallback, type ReactNode } from "react";
import { Lock, LockOpen, Eye, EyeOff, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { useToast } from "@astryxdesign/core/Toast";
import { Docs, type DocSummary } from "../api";
import type { ReviewMode } from "@stuga/protocol/domain/events";

interface DocState {
  locked: boolean;
  searchHidden: boolean;
  agentAuto: boolean;
}

export function docStateOf(doc: Pick<DocSummary, "locked" | "search_hidden" | "agent_mode">): DocState {
  return { locked: doc.locked, searchHidden: doc.search_hidden, agentAuto: doc.agent_mode === "auto" };
}

type Noun = "document" | "database";

interface DocStateFlag {
  isOn: (state: DocState) => boolean;
  label: string;
  icon: LucideIcon;
  /** The row mark's tooltip. */
  mark: string;
  badge: "warning" | "neutral";
  chip: "gray" | "yellow";
  /** The title chip's tooltip, which names where the flag is changed. */
  tooltip: (noun: Noun) => string;
}

export const DOC_STATE_FLAGS: readonly DocStateFlag[] = [
  {
    isOn: (s) => s.locked,
    label: "Locked",
    icon: Lock,
    mark: "Locked — content is frozen",
    badge: "warning",
    chip: "gray",
    tooltip: (noun) => `This ${noun} is locked for everyone. Unlock it from the ⋯ menu.`,
  },
  {
    isOn: (s) => s.searchHidden,
    label: "Hidden from search",
    icon: EyeOff,
    mark: "Hidden from search — excluded from search and AI results",
    badge: "neutral",
    chip: "gray",
    tooltip: (noun) =>
      `This ${noun} is excluded from search and AI. Change it from the ⋯ menu.`,
  },
  {
    isOn: (s) => s.agentAuto,
    label: "Agents apply at once",
    icon: Sparkles,
    mark: "Agents apply changes here at once — no review before they land",
    badge: "warning",
    chip: "yellow",
    tooltip: (_noun) =>
      `Agent changes apply without review, but remain recorded and revertible. Change it from the ⋯ menu.`,
  },
];

/** Icons beside a title in a list row, where worded badges would push the title into an ellipsis. */
export function DocStateMarks({ doc }: { doc: DocSummary | undefined }) {
  if (!doc) return null;
  const state = docStateOf(doc);
  const on = DOC_STATE_FLAGS.filter((f) => f.isOn(state));
  if (on.length === 0) return null;
  return (
    <span className="doc-state-marks">
      {on.map(({ label, mark, icon: Icon }) => (
        <span key={label} className="doc-state-mark" title={mark} aria-label={label}>
          <Icon size={13} />
        </span>
      ))}
    </span>
  );
}

interface StateMenuItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

/**
 * The toggles for a document. `onChanged` runs once optimistically and again
 * with the server's row, or with the original on a refusal.
 */
export function useDocStateMenu(): (doc: DocSummary, onChanged: (next: DocSummary) => void) => StateMenuItem[] {
  const toast = useToast();
  return useCallback(
    (doc: DocSummary, onChanged: (next: DocSummary) => void): StateMenuItem[] => {
      const noun: Noun = doc.doc_type === "database" ? "database" : "document";
      const agentAuto = doc.agent_mode === "auto";
      async function apply(
        patch: { locked?: boolean; search_hidden?: boolean; agent_mode?: ReviewMode },
        what: string,
        /** Shown only once the server agreed. */
        okBody?: string,
      ) {
        onChanged({ ...doc, ...patch });
        try {
          onChanged(await Docs.setState(doc.doc_id, patch));
          if (okBody) toast({ body: okBody, type: "info" });
        } catch (err) {
          onChanged(doc);
          const status = (err as { status?: number }).status;
          toast({
            body: status === 403 ? `Only the owner or a workspace admin can ${what}.` : `Couldn't ${what}. Please try again.`,
            type: "error",
          });
        }
      }
      return [
        {
          label: doc.locked ? "Unlock" : "Lock",
          icon: doc.locked ? <LockOpen size={15} /> : <Lock size={15} />,
          onClick: () => void apply({ locked: !doc.locked }, `${doc.locked ? "unlock" : "lock"} this ${noun}`),
        },
        {
          label: doc.search_hidden ? "Show in search" : "Hide from search",
          icon: doc.search_hidden ? <Eye size={15} /> : <EyeOff size={15} />,
          onClick: () =>
            void apply(
              { search_hidden: !doc.search_hidden },
              doc.search_hidden ? `show this ${noun} in search` : `hide this ${noun} from search`,
            ),
        },
        {
          label: agentAuto ? "Make agent changes wait for review" : "Let agents apply changes at once",
          icon: agentAuto ? <ShieldCheck size={15} /> : <Sparkles size={15} />,
          onClick: () =>
            void apply(
              { agent_mode: agentAuto ? "review" : "auto" },
              agentAuto ? `make agent changes to this ${noun} wait for review` : `let agents change this ${noun} without review`,
              // Only the permissive direction is confirmed: it is the one that gives something away.
              agentAuto
                ? undefined
                : `Agent changes now apply at once, but remain recorded and revertible.`,
            ),
        },
      ];
    },
    [toast],
  );
}
