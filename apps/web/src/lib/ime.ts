/** Keys an input method is still handling, which a field's own shortcuts must leave alone. */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Whether a keydown belongs to an input method's composition: the Enter that picks a Chinese or
 * Japanese candidate must not send, and its Escape must not close. Safari fires that Enter after
 * compositionend, with `isComposing` false and the IME's keyCode 229.
 */
export function isComposingKey(e: KeyboardEvent | ReactKeyboardEvent): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
}
