/**
 * A notice to show once the next page has loaded, for a change that reloads the app, such as
 * deleting the workspace it was showing. Kept for this tab only.
 */
import { takeStored, writeStored } from "../storage";

const KEY = "stuga.notice";

export function leaveNotice(body: string): void {
  writeStored("session", KEY, body);
}

/** The notice left before the reload, once; null when there is none. */
export function takeNotice(): string | null {
  return takeStored("session", KEY);
}
