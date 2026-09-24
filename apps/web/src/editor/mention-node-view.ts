/**
 * A mention as a chip that names the person as the directory knows them now.
 * Only a NodeView is added; the node spec is the server's, so the schemas stay
 * identical. The chip shows the label it was inserted with.
 */
import type { NodeViewRendererProps } from "@tiptap/react";
import { Mention } from "@stuga/crdt-ops";
import { principalName, resolveNames } from "../state/identity";

export const MentionView = Mention.extend({
  addNodeView() {
    return (props: NodeViewRendererProps) => {
      const alias = String(props.node.attrs.alias);
      const dom = document.createElement("span");
      dom.className = "mention";
      dom.setAttribute("data-mention", "");
      dom.setAttribute("contenteditable", "false");
      dom.textContent = `@${props.node.attrs.label}`;
      resolveNames([`user:${alias}`]);
      // The title is read on hover, by which time the name has usually arrived.
      dom.addEventListener("mouseenter", () => {
        dom.title = principalName(`user:${alias}`);
      });
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => updated.type.name === props.node.type.name && updated.attrs.alias === alias,
      };
    };
  },
});
