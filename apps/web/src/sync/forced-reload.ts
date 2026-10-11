/**
 * A reload the node forced: the document was rolled back (a new epoch, DOC_RESET) or the page is older than
 * its text. What this page had not sent cannot be kept, so nothing asks before it goes.
 */
let forced = false;

export function forceReload(): void {
  forced = true;
  location.reload();
}

/** Whether the page is reloading because the node said so; the leave guard stands aside. */
export function isForcedReload(): boolean {
  return forced;
}
