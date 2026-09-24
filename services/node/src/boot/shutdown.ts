/**
 * Graceful shutdown: every step in order, within a deadline. The steps do not
 * bound themselves (an AI turn can take minutes), so the node gives up before
 * the supervisor's SIGKILL and names the step it was still waiting on.
 */

/** Inside the 30 s a supervisor must allow after SIGTERM. */
export const SHUTDOWN_DEADLINE_MS = 25_000;

interface ShutdownStep {
  /** What the log calls it, e.g. "document actors". */
  name: string;
  run: () => unknown;
}

type ShutdownOutcome =
  | { outcome: "done" }
  | { outcome: "failed"; step: string; error: unknown }
  | { outcome: "deadline"; step: string };

/** Run the steps in order; stop at the first that throws, or when the deadline passes. */
export async function runShutdown(steps: ShutdownStep[], deadlineMs: number = SHUTDOWN_DEADLINE_MS): Promise<ShutdownOutcome> {
  let current = steps[0]?.name ?? "";
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<ShutdownOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "deadline", step: current }), deadlineMs);
  });
  const work = (async (): Promise<ShutdownOutcome> => {
    for (const step of steps) {
      current = step.name;
      try {
        await step.run();
      } catch (error) {
        return { outcome: "failed", step: step.name, error };
      }
    }
    return { outcome: "done" };
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
