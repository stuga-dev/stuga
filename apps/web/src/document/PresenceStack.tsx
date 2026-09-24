/**
 * Who is in the document, from Yjs awareness. People are de-duplicated by
 * `label`: the alias can collide across email domains, and a client id is per
 * tab. This is the only non-visual channel for presence, since carets are
 * aria-hidden, so badges are buttons that jump to that person's cursor, the
 * stack is a labelled group, and arrivals and departures go to a live region.
 * Badges are drawn here, not with Astryx Avatar, for white-on-colour contrast.
 */
import { useCallback, useEffect, useState } from "react";
import * as Y from "yjs";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useToast } from "@astryxdesign/core/Toast";
import { resolveRelRange } from "../editor/rel-range";
import { initials } from "../state/identity";
import { useSharedEditor } from "../editor/editor-context";
import { jumpTo } from "../editor/use-citation-jump";
import type { StugaProvider } from "../sync/stuga-provider";

/** The blocks jumpTo scrolls to, as for citations. */
const BLOCKS = "p, li, blockquote, td, th, pre, h1, h2, h3, h4, h5, h6";

/** Peers present at open are not announced; their states arrive a round trip after connect. */
const ANNOUNCE_AFTER_MS = 2_000;

/**
 * A goodbye (origin "remote") is announced at once. A departure inferred from
 * awareness's 30s timeout cull (origin "timeout") waits this long, since a
 * throttled background tab or our own half-open socket also causes one and the
 * peer reappears within about a minute. Only the narration waits; the roster
 * label updates at once.
 */
const INFERRED_DEPARTURE_GRACE_MS = 60_000;

/** For tests. */
export const __TIMINGS = { ANNOUNCE_AFTER_MS, INFERRED_DEPARTURE_GRACE_MS };

interface Peer {
  /** Short alias (caret label). */
  name: string;
  /** Display name or email; falls back to name. */
  label: string;
  color: string;
  /** An AI agent connection. */
  agent: boolean;
  /** Every connection this person has open; only a focused one has a cursor. */
  clientIds: number[];
  /** This browser. */
  isSelf: boolean;
}

/** The awareness cursor field y-tiptap publishes: relative positions, as JSON. */
interface AwarenessCursor {
  anchor: unknown;
  head: unknown;
}

export function PresenceStack({ provider }: { provider: StugaProvider }) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const { editor } = useSharedEditor();
  const toast = useToast();

  useEffect(() => {
    const aw = provider.awareness;
    /** Labels the reader has been told are present. */
    const announced = new Set<string>();
    /** clientId -> label as of the last read, to name whoever a change event removes. */
    const labelOf = new Map<number, string>();
    /** Our own label, never narrated. */
    let selfLabel: string | null = null;
    /**
     * Inferred departures waiting out the grace period. One change's departures
     * share a timer and a sentence, since a live region announces only its last
     * value. A peer who returns is deleted here, and the timer skips them.
     */
    const leaving = new Map<string, ReturnType<typeof setTimeout>>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let armed = false;
    const arm = setTimeout(() => {
      armed = true;
    }, ANNOUNCE_AFTER_MS);

    const say = (text: string) => setAnnouncement(text);

    const read = (change?: { removed: number[] }, origin?: unknown) => {
      const saidGoodbye = new Set<string>();
      if (change && origin !== "timeout") {
        for (const clientId of change.removed) {
          const label = labelOf.get(clientId);
          if (label !== undefined) saidGoodbye.add(label);
        }
      }

      const seen = new Map<string, Peer>();
      for (const [clientId, state] of aw.getStates()) {
        const u = (state as { user?: { name?: string; label?: string; color?: string; agent?: boolean } }).user;
        if (!u?.name) continue;
        const label = u.label ?? u.name;
        const existing = seen.get(label);
        if (existing) existing.clientIds.push(clientId);
        else {
          seen.set(label, {
            name: u.name,
            label,
            color: u.color ?? "#888",
            agent: !!u.agent,
            clientIds: [clientId],
            isSelf: false,
          });
        }
      }
      labelOf.clear();
      for (const peer of seen.values()) {
        peer.isSelf = peer.clientIds.includes(provider.doc.clientID);
        if (peer.isSelf) selfLabel = peer.label;
        for (const clientId of peer.clientIds) labelOf.set(clientId, peer.label);
      }
      setPeers([...seen.values()]);

      if (!armed) {
        announced.clear();
        for (const label of seen.keys()) announced.add(label);
        return;
      }

      // Back within the grace period: not announced. Their shared timer may still carry others.
      for (const label of seen.keys()) leaving.delete(label);

      const gone = [...announced].filter(
        (label) => !seen.has(label) && !leaving.has(label) && label !== selfLabel,
      );
      const observed = gone.filter((label) => saidGoodbye.has(label));
      if (observed.length > 0) {
        for (const label of observed) announced.delete(label);
        say(`${observed.join(", ")} left.`);
      }
      const inferred = gone.filter((label) => !saidGoodbye.has(label));
      if (inferred.length > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          const left = inferred.filter((label) => leaving.get(label) === timer);
          for (const label of left) {
            leaving.delete(label);
            announced.delete(label);
          }
          if (left.length > 0) say(`${left.join(", ")} left.`);
        }, INFERRED_DEPARTURE_GRACE_MS);
        timers.add(timer);
        for (const label of inferred) leaving.set(label, timer);
      }
      const joined = [...seen.keys()].filter((label) => !announced.has(label));
      if (joined.length > 0) {
        for (const label of joined) announced.add(label);
        say(`${joined.join(", ")} joined.`);
      }
    };

    read();
    aw.on("change", read);
    return () => {
      aw.off("change", read);
      clearTimeout(arm);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [provider]);

  /** Move the local caret to the collaborator's and scroll there, as a citation jump does. */
  const goToPeer = useCallback(
    (peer: Peer) => {
      if (!editor || editor.isDestroyed) return;
      const states = provider.awareness.getStates();
      let head: number | null = null;
      for (const clientId of peer.clientIds) {
        const cursor = (states.get(clientId) as { cursor?: AwarenessCursor } | undefined)?.cursor;
        if (!cursor) continue;
        try {
          const range = resolveRelRange(provider.doc, editor.state, {
            from: Y.createRelativePositionFromJSON(cursor.anchor),
            to: Y.createRelativePositionFromJSON(cursor.head),
          });
          // Only their head: adopting their selection would leave text selected the reader cannot see.
          if (range) {
            head = Math.max(0, Math.min(range.to, editor.state.doc.content.size));
            break;
          }
        } catch {
          // Awareness is untrusted input; try the next connection.
        }
      }
      if (head === null) {
        toast({ body: `${peer.label} doesn't have a cursor in this document right now.`, type: "info" });
        return;
      }
      if (editor.isEditable) {
        try {
          editor.chain().setTextSelection({ from: head, to: head }).focus(undefined, { scrollIntoView: false }).run();
        } catch {
          // A node selection has no text position; still scroll.
        }
      }
      const node = editor.view.domAtPos(head).node;
      const block = (
        node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
      )?.closest<HTMLElement>(BLOCKS);
      if (!block) return;
      jumpTo(block);
      // A read-only editor moves no caret, so focus the block for screen readers.
      if (!editor.isEditable) {
        block.tabIndex = -1;
        block.focus();
      }
    },
    [editor, provider, toast],
  );

  if (peers.length === 0) return null;
  const shown = peers.slice(0, 5);
  const extra = peers.length - shown.length;
  return (
    // aria-label is ignored without a role.
    <div className="presence-stack" role="group" aria-label={`In this document: ${peers.map((p) => p.label).join(", ")}`}>
      {shown.map((p) => {
        const className = p.agent ? "presence-badge presence-badge--agent" : "presence-badge";
        const glyph = p.agent ? "✦" : initials(p.name);
        return (
          // On touch, a tap on an action button opens no tooltip by default.
          <Tooltip
            key={p.label}
            touchTrigger="tap"
            content={
              <span className="presence-tip">
                <strong>{p.name}</strong>
                {p.label !== p.name && <span className="presence-tip__sub">{p.label}</span>}
              </span>
            }
          >
            {p.isSelf ? (
              // Pressing it would blur the editor and clear this client's own cursor.
              <span className={className} style={{ background: p.color }} aria-hidden="true">
                {glyph}
              </span>
            ) : (
              <button
                type="button"
                className={className}
                style={{ background: p.color }}
                aria-label={`Go to ${p.label}${p.agent ? " (AI agent)" : ""}`}
                onClick={() => goToPeer(p)}
              >
                {glyph}
              </button>
            )}
          </Tooltip>
        );
      })}
      {extra > 0 && (
        <span className="presence-badge presence-badge--overflow" aria-hidden="true">
          +{extra}
        </span>
      )}
      <span className="presence-live" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
