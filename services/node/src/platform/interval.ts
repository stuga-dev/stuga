/**
 * A periodic tick that never overlaps itself: a tick still running when the next is due skips
 * that one. A failing tick goes to `onError` and the schedule continues.
 */
interface IntervalHandle {
  /** Run a tick now; one already running is followed by another as soon as it ends. */
  kick(): void;
  /** Stop scheduling; resolves once a tick in flight has finished. */
  stop(): Promise<void>;
}

export function startInterval(
  ms: number,
  fn: () => Promise<void> | void,
  options: { onError?: (error: unknown) => void } = {},
): IntervalHandle {
  const onError = options.onError ?? ((e: unknown) => console.error("[interval] tick failed", e));
  let inFlight: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = Promise.resolve()
      .then(fn)
      .catch(onError)
      .finally(() => {
        inFlight = null;
        if (again) {
          again = false;
          tick();
        }
      });
  };

  const timer = setInterval(tick, ms);

  return {
    kick() {
      if (stopped) return;
      if (inFlight) again = true;
      else tick();
    },
    async stop() {
      stopped = true;
      again = false;
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}
