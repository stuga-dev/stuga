/**
 * A right-hand dock: every panel the page offers has a tab, one is in front,
 * and the strip's end holds that panel's actions and a close button. Hiding
 * the dock keeps the panel in front. The state is stored per browser and
 * validated on read, since anything can write the key.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { readStored, writeStored } from "../lib/storage";
import { ResizeHandle } from "./ResizeHandle";
import { COMPACT_QUERY, useIsCompact } from "./narrow";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/HStack";
import { PanelRight, X } from "lucide-react";

/** A tab the page may dock. */
interface DockSlot<Id extends string = string> {
  id: Id;
  /** False withholds the tab, e.g. AI on a read-only item, or Row while no row is open. */
  when?: boolean;
}

interface DockTabSpec<Id extends string = string> {
  id: Id;
  label: string;
  icon: ReactNode;
  /** A count shown after the label. */
  badge?: number;
  /** The panel's own buttons, shown at the strip's end while it is in front. */
  actions?: ReactNode;
  /** What the close button does instead of hiding the dock, e.g. closing the open row. */
  close?: { label: string; onClose: () => void };
  render: () => ReactNode;
}

interface DockState<Id extends string = string> {
  /** The panel in front, remembered while the dock is hidden. */
  active: Id | null;
  visible: boolean;
  /** What `active` replaced: a panel, or null when the dock came up for it. */
  previous: Id | null;
}

/** Parse a stored value; anything unrecognised gets `initial`, as a browser with nothing stored does. */
export function readDockState<Id extends string>(raw: string | null, ids: readonly Id[], initial: DockState<Id>): DockState<Id> {
  const isId = (v: unknown): v is Id => ids.includes(v as Id);
  try {
    const parsed = JSON.parse(raw ?? "null") as { active?: unknown; visible?: unknown; previous?: unknown } | null;
    if (!isId(parsed?.active)) return initial;
    return { active: parsed.active, visible: parsed.visible === true, previous: isId(parsed.previous) ? parsed.previous : null };
  } catch {
    return initial;
  }
}

/**
 * When the page withholds the panel in front, go back to the one it replaced,
 * or hide a dock that came up for it. The same object when nothing changes.
 */
export function pruneDockState<Id extends string>(state: DockState<Id>, available: readonly Id[]): DockState<Id> {
  if (state.active !== null && available.includes(state.active)) return state;
  if (state.previous !== null && available.includes(state.previous)) {
    return { active: state.previous, visible: state.visible, previous: null };
  }
  return { active: available[0] ?? null, visible: false, previous: null };
}

/** Bring a panel to the front and show the dock, remembering what it replaced. */
export function dockOpen<Id extends string>(state: DockState<Id>, tab: Id): DockState<Id> {
  if (state.visible && state.active === tab) return state;
  return { active: tab, visible: true, previous: state.visible ? state.active : null };
}

/** Hide a visible dock, or show it again with the remembered panel in front. */
export function dockToggle<Id extends string>(state: DockState<Id>): DockState<Id> {
  return { ...state, visible: !state.visible && state.active !== null };
}

/** The ids of the slots whose `when` holds, in declared order. */
export function availableTabs<Id extends string>(slots: ReadonlyArray<DockSlot<Id>>): Id[] {
  return slots.filter((s) => s.when !== false).map((s) => s.id);
}

export interface DockController<Id extends string> {
  state: DockState<Id>;
  /** The slots whose `when` holds, in declared order. */
  available: readonly Id[];
  /** Bring a panel to the front, showing the dock if it is hidden. */
  open: (tab: Id) => void;
  toggle: () => void;
}

/**
 * A browser with nothing stored starts with `defaultActive` in front, shown
 * unless the window is compact, where the dock would cover the page. Where
 * that panel is withheld the dock waits to be asked for.
 */
export function useDockState<Id extends string>(
  storageKey: string,
  slots: ReadonlyArray<DockSlot<Id>>,
  defaultActive: Id,
): DockController<Id> {
  const key = availableTabs(slots).join("\n");
  // Keyed on the ids, so a fresh slot array each render keeps the same `available`.
  const available = useMemo(() => (key ? (key.split("\n") as Id[]) : []), [key]);
  const [stored, setStored] = useState<DockState<Id>>(() =>
    readDockState(
      readStored("local", storageKey),
      slots.map((s) => s.id),
      { active: defaultActive, visible: !window.matchMedia(COMPACT_QUERY).matches, previous: null },
    ),
  );
  const state = useMemo(() => pruneDockState(stored, available), [stored, available]);
  const commit = useCallback(
    (next: DockState<Id>) => {
      setStored(next);
      writeStored("local", storageKey, JSON.stringify(next));
    },
    [storageKey],
  );
  return {
    state,
    available,
    open: (tab) => commit(dockOpen(state, tab)),
    toggle: () => commit(dockToggle(state)),
  };
}

/** The header's one dock button. */
export function DockToggle({ isPressed, onToggle, tooltip }: { isPressed: boolean; onToggle: () => void; tooltip: string }) {
  return (
    <ToggleButton
      label="Side panels"
      tooltip={tooltip}
      isIconOnly
      icon={<PanelRight size={18} />}
      size="sm"
      isPressed={isPressed}
      onPressedChange={onToggle}
    />
  );
}

/**
 * Renders nothing while the dock is hidden; shows only the specs `dock` makes available.
 * Beside the page it has `width` and a handle to resize it. A compact window gets
 * neither: there editor.css's `max-width: 1099px` rule, COMPACT_QUERY's twin, lays
 * the dock over the page.
 */
export function Dock<Id extends string>({
  dock,
  tabs,
  width,
  onResize,
}: {
  dock: DockController<Id>;
  /** Every panel the page can dock, in strip order. */
  tabs: ReadonlyArray<DockTabSpec<Id>>;
  width: number;
  /** Omitted, the width is fixed and no handle is drawn. */
  onResize?: (next: number) => void;
}) {
  const isCompact = useIsCompact();
  const { active, visible } = dock.state;
  if (!visible || active === null) return null;
  const shown = tabs.filter((t) => dock.available.includes(t.id));
  const front = shown.find((t) => t.id === active);
  const closeLabel = front?.close?.label ?? "Close side panels";

  return (
    <>
      {!isCompact && onResize && <ResizeHandle width={width} onResize={onResize} dir={-1} label="Resize side panels" />}
      <aside className="side-panel dock" style={isCompact ? undefined : { width }} aria-label="Side panels">
        <HStack vAlign="center" hAlign="between" gap={1} paddingInlineEnd={1}>
          <TabList value={active} onChange={(v) => dock.open(v as Id)} size="sm" layout="hug" aria-label="Panels">
            {shown.map((t) => (
              <Tab
                key={t.id}
                value={t.id}
                label={t.label}
                icon={t.icon}
                // Only the tab in front shows its label, so every panel fits a narrow dock.
                isLabelHidden={t.id !== active}
                endContent={t.badge ? <Badge variant="neutral" label={String(t.badge)} /> : undefined}
              />
            ))}
          </TabList>
          <HStack vAlign="center" gap={0}>
            {front?.actions}
            <IconButton
              label={closeLabel}
              tooltip={closeLabel}
              variant="ghost"
              size="sm"
              icon={<X size={16} />}
              onClick={front?.close?.onClose ?? dock.toggle}
            />
          </HStack>
        </HStack>
        {front?.render()}
      </aside>
    </>
  );
}
