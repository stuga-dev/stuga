/**
 * A centred column of the given width in a full-pane scroller. The width sits
 * inside the scroll container, so the scrollbar stays at the pane's edge rather
 * than beside the column.
 */
import type { ReactNode } from "react";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";

export function PageColumn({ width = 760, children }: { width?: number; children: ReactNode }) {
  return (
    <Layout height="fill">
      <LayoutContent padding={6}>
        <div style={{ width: "100%", maxWidth: width, marginInline: "auto" }}>{children}</div>
      </LayoutContent>
    </Layout>
  );
}
