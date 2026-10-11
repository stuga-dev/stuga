/**
 * Stands in for "@astryxdesign/core/Toast" and records every toast raised:
 * `vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"))`. A test file clears `toasts.shown` itself.
 */
import type { ToastOptions } from "@astryxdesign/core/Toast";
import { withToastDefaults } from "../ui/toast-defaults";

export interface ShownToast {
  body: string;
  type?: string;
  /** A toast's trailing control, such as Undo; render it to press it. */
  endContent?: unknown;
}

export const toasts = { shown: [] as ShownToast[] };

/** What each toast said, in order. */
export const toastBodies = (): string[] => toasts.shown.map((t) => t.body);

const FILLED = ["isAutoHide", "autoHideDuration", "uniqueID"] as const;

/** The toast as its caller asked for it: drops what the app's `useToast` filled in, which no test is about. */
function asAsked(t: ShownToast): ShownToast {
  const { body, type, endContent } = t as ToastOptions;
  const filled = withToastDefaults({ body, type, endContent });
  const asked: Record<string, unknown> = { ...t };
  for (const key of FILLED) if (asked[key] === filled[key]) delete asked[key];
  return asked as unknown as ShownToast;
}

/** Returns the toast's dismiss, as Astryx's does; dismissing a recorded toast changes nothing. */
export const useToast = () => (t: ShownToast) => {
  toasts.shown.push(asAsked(t));
  return () => {};
};
