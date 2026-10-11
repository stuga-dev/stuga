import type { FocusEvent } from "react";

/** A rename field's `onFocus`: its whole value is selected, so typing replaces the old name rather than joining it. */
export function selectOnFocus(e: FocusEvent<HTMLInputElement>): void {
  e.currentTarget.select();
}
