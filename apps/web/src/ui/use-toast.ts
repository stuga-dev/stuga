/** The app's `useToast`: Astryx's, with the defaults in ./toast-defaults. */
import { useCallback } from "react";
// eslint-disable-next-line no-restricted-imports -- the one place that wraps it
import { useToast as useAstryxToast, type ShowToastFn, type ToastOptions } from "@astryxdesign/core/Toast";
import { withToastDefaults } from "./toast-defaults";

export function useToast(): ShowToastFn {
  const show = useAstryxToast();
  return useCallback((options: ToastOptions) => show(withToastDefaults(options)), [show]);
}
