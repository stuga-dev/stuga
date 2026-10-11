/**
 * What `useToast` (./use-toast) fills in on a toast. Astryx keeps an error toast
 * up until it is closed, so one stayed through every page after it and sat over
 * the buttons below it. Here every toast hides itself, an error after
 * ERROR_HIDE_MS and anything else after INFO_HIDE_MS, and the same message
 * raised again replaces the one showing rather than stacking. A caller's own
 * options win.
 */
import type { ToastOptions } from "@astryxdesign/core/Toast";

export const ERROR_HIDE_MS = 8_000;
export const INFO_HIDE_MS = 5_000;

export function withToastDefaults(options: ToastOptions): ToastOptions {
  return {
    isAutoHide: true,
    autoHideDuration: options.type === "error" ? ERROR_HIDE_MS : INFO_HIDE_MS,
    // A toast with a control, such as Undo, acts on its own moment, so only plain text collapses.
    uniqueID: typeof options.body === "string" && options.endContent == null ? `message:${options.body}` : undefined,
    ...options,
  };
}
