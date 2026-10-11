/**
 * The pure model behind the connection indicator: "are my edits getting
 * through?" Evidence is ranked and a weaker source never overrules a stronger
 * one:
 *   1. Server receipts (UPDATE_ACK). An edit past its receipt deadline is
 *      stranded whatever the socket claims: a browser that lost its network
 *      keeps `readyState === OPEN` while `send()` discards the bytes.
 *   2. A completed sync handshake on the current socket, which re-delivers and
 *      acks whatever the server lacked.
 *   3. Socket lifecycle events, which may only make the readout worse.
 * Durability is a separate, server-sourced axis (PERSIST_DEGRADED): a receipt
 * proves acceptance, never storage, so no wording here says "saved".
 */
import { t, type MessageKey } from "../i18n/i18n";
import type { SyncEnding } from "./stuga-provider";

/** An outage shows a label only after this long, past the first reconnect attempts. */
export const SHOW_RECONNECT_LABEL_AFTER_MS = 3_000;

/** Stranded edits older than this escalate to red. */
export const STRANDED_ESCALATION_MS = 10_000;

/** Undurable longer than this escalates to red. Longer than the actor's 30s flush backstop, so a retry can clear it first. */
export const UNDURABLE_ESCALATION_MS = 60_000;

/** How long the "Connected" confirmation stays after a recovery. */
export const RECOVERY_FLASH_MS = 2_500;

type IndicatorPhase =
  /** First handshake still pending. */
  | "connecting"
  | "connected"
  /** Just recovered; showing the confirmation. */
  | "recovered"
  /** Transport down, within the quiet window. */
  | "reconnecting"
  /** Transport down past SHOW_RECONNECT_LABEL_AFTER_MS. */
  | "delayed"
  /** Transport down, and the browser says it has no network. */
  | "offline"
  /** A local edit has no receipt. */
  | "at-risk"
  /** Stranded past STRANDED_ESCALATION_MS. */
  | "prolonged"
  /** Receipts arrive, but the server says it cannot store. */
  | "undurable"
  | "undurable-prolonged"
  /** Access revoked. Terminal. */
  | "revoked"
  /** The item was deleted. Terminal. */
  | "deleted"
  /** The person is no longer a member of its workspace. Terminal. */
  | "removed";

/** One of the design system's StatusDot variants. */
type IndicatorTone = "neutral" | "success" | "warning" | "error";

export interface IndicatorReadout {
  phase: IndicatorPhase;
  tone: IndicatorTone;
  /** Pill text; null while the indicator is a bare dot. */
  label: string | null;
  /** Screen-reader and tooltip sentence, present in every phase. */
  srText: string;
  expanded: boolean;
  /** Cleared only by server-sourced evidence. */
  persistent: boolean;
}

/** Immutable: every event returns a new value, or the same object when nothing changed. */
export interface LinkHealth {
  /** "current" only while the latest socket has completed a handshake. */
  handshake: "never" | "stale" | "current";
  /** When the ongoing outage or stranded edit started. */
  troubleSince: number | null;
  stranded: boolean;
  /** Server-sourced level: set and cleared only by the server, or re-asked by a handshake. */
  undurable: boolean;
  /** Its own clock, so a transport blip cannot restart the escalation. */
  undurableSince: number | null;
  flashUntil: number | null;
  /** Why syncing stopped for good, or null while it goes on. */
  ended: SyncEnding | null;
}

export function newLinkHealth(): LinkHealth {
  return {
    handshake: "never",
    troubleSince: null,
    stranded: false,
    undurable: false,
    undurableSince: null,
    flashUntil: null,
    ended: null,
  };
}

export type LinkEvent =
  | { kind: "handshake"; at: number }
  | { kind: "transport-lost"; at: number }
  /** A local edit went past its receipt deadline, or had no socket at all. */
  | { kind: "edit-stranded"; at: number }
  /** The server receipted every outstanding local edit. */
  | { kind: "edits-confirmed"; at: number }
  /** A policy refusal, not a network problem. */
  | { kind: "write-refused" }
  | { kind: "persist-degraded"; at: number }
  | { kind: "persist-recovered" }
  /** The server closed the link for good. */
  | { kind: "ended"; why: SyncEnding }
  /** Lets the recovery flash expire. */
  | { kind: "clock"; at: number };

export function advance(h: LinkHealth, e: LinkEvent): LinkHealth {
  switch (e.kind) {
    case "handshake": {
      // A plain first open gets no "Connected" flash; only trouble the reader could have seen does.
      const sawTrouble = (h.handshake !== "never" && h.troubleSince !== null) || h.stranded;
      // Clearing undurable re-asks the question: a still-degraded server re-sends
      // PERSIST_DEGRADED right after SYNC_DONE, while a healed one never would.
      return {
        ...h,
        handshake: "current",
        troubleSince: null,
        stranded: false,
        undurable: false,
        undurableSince: null,
        flashUntil: sawTrouble ? e.at + RECOVERY_FLASH_MS : null,
      };
    }
    case "transport-lost": {
      // Repeated losses in one outage keep the first timestamp, or the label threshold is never reached.
      if (h.troubleSince !== null && h.handshake !== "current") return h;
      return {
        ...h,
        handshake: h.handshake === "never" ? "never" : "stale",
        troubleSince: h.troubleSince ?? e.at,
      };
    }
    case "edit-stranded": {
      // Before the first handshake, anything typed rides that handshake.
      if (h.handshake === "never" || h.stranded) return h;
      return { ...h, stranded: true, troubleSince: h.troubleSince ?? e.at };
    }
    case "edits-confirmed": {
      if (!h.stranded) return h;
      return { ...h, stranded: false, troubleSince: null, flashUntil: e.at + RECOVERY_FLASH_MS };
    }
    case "write-refused": {
      // No receipt is coming; nothing recovered, so no flash.
      if (!h.stranded) return h;
      return { ...h, stranded: false, troubleSince: null };
    }
    case "persist-degraded": {
      // A repeat must not restart the escalation clock.
      if (h.undurable) return h;
      return { ...h, undurable: true, undurableSince: e.at };
    }
    case "persist-recovered": {
      if (!h.undurable) return h;
      return { ...h, undurable: false, undurableSince: null };
    }
    case "ended":
      return { ...h, ended: e.why, stranded: false, undurable: false, undurableSince: null, flashUntil: null };
    case "clock": {
      if (h.flashUntil !== null && e.at >= h.flashUntil) return { ...h, flashUntil: null };
      return h;
    }
  }
}

/** Local edits the node has not confirmed: leaving the page now would lose them. */
export function hasUnsentEdits(r: IndicatorReadout): boolean {
  return r.phase === "at-risk" || r.phase === "prolonged";
}

/** Whether elapsed time can still change the readout, so the hook keeps a clock running. */
export function wantsTicks(h: LinkHealth, transportUp: boolean): boolean {
  if (h.ended) return false;
  if (h.flashUntil !== null) return true;
  if (h.stranded) return true;
  if (h.undurable) return true;
  return !(transportUp && h.handshake === "current");
}

/** The pill's words and the full sentence, per ending. */
const ENDED_WORDS: Record<SyncEnding, [pill: MessageKey, sentence: MessageKey]> = {
  revoked: ["ui.linkHealth.noAccess", "ui.linkHealth.noAccessDetail"],
  deleted: ["ui.linkHealth.deleted", "ui.linkHealth.deletedDetail"],
  removed: ["ui.linkHealth.removed", "ui.linkHealth.removedDetail"],
};

/**
 * What the indicator shows, worst news first. The retrying is this tab's, so no
 * sentence names the workspace. `online` is the browser's word on the network:
 * it only picks the wording once the link is known to be down, since a node on
 * this computer keeps working offline.
 */
export function readout(h: LinkHealth, transportUp: boolean, at: number, online = true): IndicatorReadout {
  if (h.ended) {
    const [pill, sentence] = ENDED_WORDS[h.ended];
    return { phase: h.ended, tone: "error", label: t(pill), srText: t(sentence), expanded: true, persistent: true };
  }

  if (h.stranded) {
    const age = h.troubleSince === null ? 0 : Math.max(0, at - h.troubleSince);
    const loud = age >= STRANDED_ESCALATION_MS;
    // One wording; only the tone escalates.
    return {
      phase: loud ? "prolonged" : "at-risk",
      tone: loud ? "error" : "warning",
      label: t("ui.linkHealth.unsent"),
      srText: online ? t("ui.linkHealth.unsentDetail") : t("ui.linkHealth.unsentOfflineDetail"),
      expanded: true,
      persistent: true,
    };
  }

  if (h.undurable) {
    const age = h.undurableSince === null ? 0 : Math.max(0, at - h.undurableSince);
    const loud = age >= UNDURABLE_ESCALATION_MS;
    return {
      phase: loud ? "undurable-prolonged" : "undurable",
      tone: loud ? "error" : "warning",
      label: loud ? t("ui.linkHealth.stillCantStore") : t("ui.linkHealth.cantStore"),
      srText: loud ? t("ui.linkHealth.stillCantStoreDetail") : t("ui.linkHealth.cantStoreDetail"),
      expanded: true,
      persistent: true,
    };
  }

  if (transportUp && h.handshake === "current") {
    const flashing = h.flashUntil !== null && at < h.flashUntil;
    return {
      phase: flashing ? "recovered" : "connected",
      tone: "success",
      label: flashing ? t("ui.linkHealth.connected") : null,
      srText: t("ui.linkHealth.connectedDetail"),
      expanded: flashing,
      persistent: false,
    };
  }

  if (h.handshake === "never") {
    return {
      phase: "connecting",
      tone: "neutral",
      label: null,
      srText: t("ui.linkHealth.connectingDetail"),
      expanded: false,
      persistent: false,
    };
  }

  if (!online) {
    return {
      phase: "offline",
      tone: "warning",
      label: t("ui.linkHealth.offline"),
      srText: t("ui.linkHealth.offlineDetail"),
      expanded: true,
      persistent: false,
    };
  }

  const age = h.troubleSince === null ? 0 : Math.max(0, at - h.troubleSince);
  const labelled = age >= SHOW_RECONNECT_LABEL_AFTER_MS;
  return {
    phase: labelled ? "delayed" : "reconnecting",
    tone: "warning",
    label: labelled ? t("ui.linkHealth.reconnecting") : null,
    srText: t("ui.linkHealth.reconnectingDetail"),
    expanded: labelled,
    persistent: false,
  };
}
