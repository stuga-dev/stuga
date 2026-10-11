/**
 * A centred column of the given width in a full-pane scroller. The width sits
 * inside the scroll container, so the scrollbar stays at the pane's edge rather
 * than beside the column.
 *
 * Under a <PageColumnFrame>, every page is centred in the frame's width and its
 * own width only caps the content from the start edge: pages of different widths
 * then share one left edge and one title position, and nothing bleeds past it.
 */
import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";

const FrameWidth = createContext<number | null>(null);

/**
 * The pane's padding is outside the column, so nothing inside should bleed into it: a Table (or
 * TabList, Toolbar) otherwise reaches 24px past the column's edges and eats the gap below it.
 * A Card inside sets these again for its own padding.
 */
const NO_BLEED = {
  "--container-padding-inline-start": "0px",
  "--container-padding-inline-end": "0px",
  "--container-padding-block-start": "0px",
  "--container-padding-block-end": "0px",
} as CSSProperties;

export function PageColumnFrame({ width, children }: { width: number; children: ReactNode }) {
  return <FrameWidth.Provider value={width}>{children}</FrameWidth.Provider>;
}

export function PageColumn({ width = 760, children }: { width?: number; children: ReactNode }) {
  const frame = useContext(FrameWidth);
  return (
    <Layout height="fill">
      <LayoutContent padding={6}>
        {frame === null ? (
          <div style={{ width: "100%", maxWidth: width, marginInline: "auto" }}>{children}</div>
        ) : (
          <div style={{ ...NO_BLEED, width: "100%", maxWidth: frame, marginInline: "auto" }}>
            <div style={{ maxWidth: width }}>{children}</div>
          </div>
        )}
      </LayoutContent>
    </Layout>
  );
}
