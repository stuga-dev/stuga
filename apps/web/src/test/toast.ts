/**
 * Stands in for "@astryxdesign/core/Toast" and records every toast raised:
 * `vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"))`. A test file clears `toasts.shown` itself.
 */
export interface ShownToast {
  body: string;
  type?: string;
}

export const toasts = { shown: [] as ShownToast[] };

/** What each toast said, in order. */
export const toastBodies = (): string[] => toasts.shown.map((t) => t.body);

export const useToast = () => (t: ShownToast) => void toasts.shown.push(t);
