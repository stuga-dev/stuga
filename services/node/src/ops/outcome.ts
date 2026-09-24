/**
 * How a `stuga-node` operator command ends:
 *   0  done
 *   2  refused: a precondition did not hold, nothing was changed
 *   3  failed, nothing was changed
 *   4  failed after something was changed; the message says what, and how to put it back
 */
export type ExitCode = 0 | 2 | 3 | 4;

export class OpsError extends Error {
  readonly exitCode: 2 | 3 | 4;
  constructor(exitCode: 2 | 3 | 4, message: string) {
    super(message);
    this.name = "OpsError";
    this.exitCode = exitCode;
  }
}

export const refused = (message: string): OpsError => new OpsError(2, message);
export const failedUnchanged = (message: string): OpsError => new OpsError(3, message);
export const failedChanged = (message: string): OpsError => new OpsError(4, message);

/** Any error as an exit code. Operations wrap their own changing steps, so any other error changed nothing. */
export function exitCodeOf(err: unknown): 2 | 3 | 4 {
  return err instanceof OpsError ? err.exitCode : 3;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stop if the command was interrupted; `unchanged` says what was cleaned up and that the data was not touched. */
export function throwIfInterrupted(signal: AbortSignal | undefined, unchanged: string): void {
  if (signal?.aborted) throw failedUnchanged(`interrupted; ${unchanged}`);
}
