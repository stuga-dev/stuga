/** What a write's answer says of its change and of the queue it may wait in. */
import type { QueuedBehind } from "../backend.js";

/** The change a write went into, said once per answer so the agent passes the id on. */
export function changeSentence(changeId: string | undefined): string {
  return changeId ? ` Change ${changeId}: pass \`change_id\` "${changeId}" to every other write for this piece of work.` : "";
}

/** Why a write waits behind another of the agent's changes to the same item, and that it is no failure. */
export function queuedSentence(behind: QueuedBehind): string {
  const which = behind.change_title ? `your change ${JSON.stringify(behind.change_title)}` : "your earlier changes";
  return (
    `QUEUED behind ${which} (run ${behind.run_id}), still undecided here: this one is approved after it, and declining ` +
    "that one may leave this one to redo. Nothing is lost and nothing needs retrying."
  );
}
