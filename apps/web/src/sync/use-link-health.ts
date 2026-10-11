/**
 * React binding for the link-health model: turns provider callbacks into
 * `LinkEvent`s and supplies the clock. The transport flag comes from the
 * provider's lifecycle events, never from polling `readyState`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useOnline } from "../lib/use-online";
import {
  advance,
  newLinkHealth,
  readout,
  wantsTicks,
  type IndicatorReadout,
  type LinkEvent,
  type LinkHealth,
} from "./link-health";
import type { SyncEnding } from "./stuga-provider";

/** Tick while a threshold or the recovery flash is pending; the thresholds are seconds-scale. */
const CLOCK_MS = 500;

interface LinkSignals {
  onSyncDone: () => void;
  onSocketOpen: () => void;
  onSocketDown: () => void;
  onLocalUpdateDropped: () => void;
  onLocalUpdatesAcked: () => void;
  onWriteRejected: () => void;
  /** The server's durable-write state as a level. */
  onPersistDegraded: (degraded: boolean) => void;
  /** Syncing stopped for good. */
  onEnded: (why: SyncEnding) => void;
}

/** Health resets whenever `docId` changes. */
export function useLinkHealth(docId: string | undefined): { status: IndicatorReadout; signals: LinkSignals } {
  const [health, setHealth] = useState<LinkHealth>(newLinkHealth);
  const [transportUp, setTransportUp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const online = useOnline();

  useEffect(() => {
    setHealth(newLinkHealth());
    setTransportUp(false);
  }, [docId]);

  // Providers take their callbacks once, at construction, so the object must stay identical.
  const signalsRef = useRef<LinkSignals | null>(null);
  if (signalsRef.current === null) {
    const dispatch = (e: LinkEvent) => setHealth((h) => advance(h, e));
    signalsRef.current = {
      onSyncDone: () => dispatch({ kind: "handshake", at: Date.now() }),
      onSocketOpen: () => setTransportUp(true),
      onSocketDown: () => {
        setTransportUp(false);
        dispatch({ kind: "transport-lost", at: Date.now() });
      },
      onLocalUpdateDropped: () => dispatch({ kind: "edit-stranded", at: Date.now() }),
      onLocalUpdatesAcked: () => dispatch({ kind: "edits-confirmed", at: Date.now() }),
      onWriteRejected: () => dispatch({ kind: "write-refused" }),
      onPersistDegraded: (degraded) =>
        dispatch(degraded ? { kind: "persist-degraded", at: Date.now() } : { kind: "persist-recovered" }),
      onEnded: (why) => {
        setTransportUp(false);
        dispatch({ kind: "ended", why });
      },
    };
  }

  const ticking = wantsTicks(health, transportUp);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      setHealth((h) => advance(h, { kind: "clock", at }));
    }, CLOCK_MS);
    return () => clearInterval(id);
  }, [ticking]);

  const status = useMemo(() => readout(health, transportUp, now, online), [health, transportUp, now, online]);
  return { status, signals: signalsRef.current };
}
