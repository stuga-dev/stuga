/**
 * Makes an image's rendered size follow its width/height attributes. The
 * resize NodeView reads them only once, so an undo, a collaborator's resize or
 * an accepted edit would otherwise leave the old size on screen.
 */
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/react";
import type { NodeView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

/** A missing dimension removes the inline size, so undoing a first resize restores the natural size. */
export function applyImageSize(dom: HTMLElement, attrs: Record<string, unknown>): void {
  const img = dom instanceof HTMLImageElement ? dom : dom.querySelector("img");
  if (!img) return;
  for (const dim of ["width", "height"] as const) {
    const value = attrs[dim];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      img.style[dim] = `${value}px`;
    } else {
      img.style.removeProperty(dim);
    }
  }
}

/**
 * Wraps the resize node view to repaint the size on every update, except while
 * a drag is in flight (`data-resize-state="true"`), when the view writes it itself.
 */
export function withImageSizeSync(factory: NodeViewRenderer | null | undefined): NodeViewRenderer | null {
  if (!factory) return null;
  return (props: NodeViewRendererProps): NodeView => {
    const view = factory(props);
    const dom = view.dom as HTMLElement;
    const inner = view.update?.bind(view);

    view.update = (node: PMNode, decorations, innerDecorations) => {
      const kept = inner ? inner(node, decorations, innerDecorations) : true;
      if (kept !== false && dom.dataset?.resizeState !== "true") applyImageSize(dom, node.attrs);
      return kept;
    };
    return view;
  };
}
