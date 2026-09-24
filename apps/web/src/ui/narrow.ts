import { useMediaQuery } from "@astryxdesign/core/hooks";

/**
 * A phone, or a window about as narrow. The stylesheets' `max-width: 640px`
 * media queries are the same breakpoint; change both together.
 */
export const NARROW_QUERY = "(max-width: 640px)";
/**
 * Too narrow for content and a side panel side by side, so the dock and the library's details lay
 * over the content. The stylesheets' `max-width: 1099px` media queries are the same breakpoint;
 * change both together.
 */
export const COMPACT_QUERY = "(max-width: 1099px)";

export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}
