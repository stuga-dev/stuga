/**
 * A document's lock, search visibility and agent mode: the flags as the library
 * marks, badges and chips show them, and the menu items that change them. The
 * server allows the change only to the owner or a workspace admin, so anyone
 * else finds the items disabled with the reason, and the menu applies a change
 * optimistically and rolls back on a refusal.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { Lock, LockOpen, Eye, EyeOff, ListChecks, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { useReviewQueue } from "../review/review-queue";
import { useToast } from "../ui/use-toast";
import { useImperativeAlertDialog } from "@astryxdesign/core/AlertDialog";
import { Docs, type DocSummary } from "../api";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { t, type MessageKey } from "../i18n/i18n";
import { useManages } from "./use-manages";

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

// Getters, so each read is in the language the page loaded.
export const DOC_STATE_FLAGS: readonly DocStateFlag[] = [
  {
    isOn: (s) => s.locked,
    get label() {
      return t("library.state.locked");
    },
    icon: Lock,
    get mark() {
      return t("library.state.lockedMark");
    },
    badge: "warning",
    chip: "gray",
    tooltip: (noun) => t("library.state.lockedTooltip", { noun }),
  },
  {
    isOn: (s) => s.searchHidden,
    get label() {
      return t("library.state.hidden");
    },
    icon: EyeOff,
    get mark() {
      return t("library.state.hiddenMark");
    },
    badge: "neutral",
    chip: "gray",
    tooltip: (noun) => t("library.state.hiddenTooltip", { noun }),
  },
  {
    isOn: (s) => s.agentAuto,
    get label() {
      return t("library.state.agentAuto");
    },
    icon: Sparkles,
    get mark() {
      return t("library.state.agentAutoMark");
    },
    badge: "warning",
    chip: "yellow",
    tooltip: () => t("library.state.agentAutoTooltip"),
  },
];

/** Icons beside a title in a list row, where worded badges would push the title into an ellipsis. */
export function DocStateMarks({ doc }: { doc: DocSummary | undefined }) {
  // AI edits waiting for this person's decision, where the library knows of them.
  const waiting = useReviewQueue()?.waiting.has(doc?.doc_id ?? "") === true;
  if (!doc) return null;
  const state = docStateOf(doc);
  const on = DOC_STATE_FLAGS.filter((f) => f.isOn(state));
  if (on.length === 0 && !waiting) return null;
  return (
    <span className="doc-state-marks">
      {waiting && (
        <span className="doc-state-mark doc-state-mark--waiting" title={t("library.state.aiEditsWaiting")} aria-label={t("library.state.aiEditsWaiting")}>
          <ListChecks size={13} />
        </span>
      )}
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
  isDisabled?: boolean;
  description?: string;
}

/**
 * The toggles for a document. `onChanged` runs once optimistically and again
 * with the server's row, or with the original on a refusal. Letting AI edits apply
 * directly asks first, in `dialog`, which the caller renders.
 */
export function useDocStateMenu(): {
  items: (doc: DocSummary, onChanged: (next: DocSummary) => void) => StateMenuItem[];
  dialog: ReactNode;
} {
  const toast = useToast();
  const manages = useManages();
  const confirm = useImperativeAlertDialog();
  const items = useCallback(
    (doc: DocSummary, onChanged: (next: DocSummary) => void): StateMenuItem[] => {
      const noun: Noun = doc.doc_type === "database" ? "database" : "document";
      const agentAuto = doc.agent_mode === "auto";
      /** The refusal and the failure for one change, each naming the item. */
      async function apply(
        patch: { locked?: boolean; search_hidden?: boolean; agent_mode?: ReviewMode },
        refusal: { denied: MessageKey; failed: MessageKey },
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
          toast({ body: t(status === 403 ? refusal.denied : refusal.failed, { noun }), type: "error" });
        }
      }
      const entries: StateMenuItem[] = [
        {
          label: doc.locked ? t("library.state.unlock") : t("library.state.lock"),
          icon: doc.locked ? <LockOpen size={15} /> : <Lock size={15} />,
          onClick: () =>
            void apply(
              { locked: !doc.locked },
              doc.locked
                ? { denied: "library.state.unlockDenied", failed: "library.state.unlockFailed" }
                : { denied: "library.state.lockDenied", failed: "library.state.lockFailed" },
            ),
        },
        {
          label: doc.search_hidden ? t("library.state.showInSearch") : t("library.state.hideFromSearch"),
          icon: doc.search_hidden ? <Eye size={15} /> : <EyeOff size={15} />,
          onClick: () =>
            void apply(
              { search_hidden: !doc.search_hidden },
              doc.search_hidden
                ? { denied: "library.state.showDenied", failed: "library.state.showFailed" }
                : { denied: "library.state.hideDenied", failed: "library.state.hideFailed" },
            ),
        },
        {
          label: agentAuto ? t("library.state.makeReview") : t("library.state.makeAuto"),
          icon: agentAuto ? <ShieldCheck size={15} /> : <Sparkles size={15} />,
          // Only the permissive direction asks first and is confirmed: it is the one that gives something away.
          onClick: () =>
            agentAuto
              ? void apply({ agent_mode: "review" }, { denied: "library.state.reviewDenied", failed: "library.state.reviewFailed" })
              : confirm.show({
                  title: t("library.state.makeAutoConfirmTitle"),
                  description: t("library.state.makeAutoConfirm", { noun }),
                  actionLabel: t("library.state.makeAuto"),
                  actionVariant: "primary",
                  onAction: () => {
                    confirm.hide();
                    void apply(
                      { agent_mode: "auto" },
                      { denied: "library.state.autoDenied", failed: "library.state.autoFailed" },
                      t("library.state.agentAutoDone"),
                    );
                  },
                }),
        },
      ];
      if (manages(doc.owner)) return entries;
      // The reason once, under the first of the three it covers.
      return entries.map((item, i) => ({ ...item, isDisabled: true, ...(i === 0 ? { description: t("library.state.managersOnly") } : {}) }));
    },
    [toast, manages, confirm.show, confirm.hide],
  );
  return useMemo(() => ({ items, dialog: confirm.element }), [items, confirm.element]);
}
