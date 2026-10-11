/**
 * Whether a live socket still reaches the node. A browser that lost its network
 * keeps `readyState === OPEN` for a minute while send() discards the bytes, and
 * nothing fires, so the socket is asked: a PING on a cadence, and at once when
 * the browser reports a network change or the tab comes back, that anything
 * inbound must answer within PROBE_DEADLINE_MS. The host answers PING without
 * waking the actor.
 */
import { Heartbeat } from "@stuga/protocol/wire/opcodes";

/** How often an idle socket is asked; with the deadline, the longest a dead link goes unnoticed. */
export const PROBE_EVERY_MS = 10_000;

/** A healthy link answers in milliseconds; this leaves room for a slow phone network. */
export const PROBE_DEADLINE_MS = 4_000;

/** Silence this long ends the socket even before probes are answerable, as during a large first sync. */
const SILENCE_MS = 60_000;

export class SocketLiveness {
  private lastInbound = Date.now();
  private cadence: ReturnType<typeof setInterval>;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  /** Until set, a probe keeps the socket warm but has no deadline: a large frame may hold the answer up. */
  private answerable: boolean;
  private stopped = false;

  /** `onDead` runs once, when the socket stops answering. */
  constructor(
    private readonly ws: WebSocket,
    private readonly onDead: () => void,
    { answerable = true }: { answerable?: boolean } = {},
  ) {
    this.answerable = answerable;
    this.cadence = setInterval(() => this.tick(), PROBE_EVERY_MS);
  }

  /** Anything from the node proves the link. */
  heard(): void {
    this.lastInbound = Date.now();
    if (this.deadline !== null) {
      clearTimeout(this.deadline);
      this.deadline = null;
    }
  }

  /** From now on a probe must be answered in time. */
  expectAnswers(): void {
    this.answerable = true;
  }

  /** Ask now. A probe already waiting is not restarted, so repeated asking cannot postpone the verdict. */
  probe(): void {
    if (this.stopped) return;
    // Read before sending: the ping itself counts until the browser hands it on.
    const uploading = this.ws.bufferedAmount > 0;
    try {
      this.ws.send(Heartbeat.PING);
    } catch {
      this.die();
      return;
    }
    if (!this.answerable || this.deadline !== null) return;
    // Behind a large edit still uploading, the answer waits on a slow link, not a dead one: the next
    // probe asks again, and the silence backstop still holds.
    if (uploading) return;
    // Anything heard meanwhile cancels this.
    this.deadline = setTimeout(() => {
      this.deadline = null;
      // A hidden tab's timers run late, possibly ahead of an answer already queued; coming back asks again.
      if (isHidden()) return;
      this.die();
    }, PROBE_DEADLINE_MS);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.cadence);
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private tick(): void {
    if (!isHidden() && Date.now() - this.lastInbound > SILENCE_MS) {
      this.die();
      return;
    }
    this.probe();
  }

  private die(): void {
    if (this.stopped) return;
    this.stop();
    this.onDead();
  }
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}
