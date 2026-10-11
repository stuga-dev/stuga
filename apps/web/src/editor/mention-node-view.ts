/**
 * A mention as a chip that names the person as the directory knows them now,
 * so a rename shows in every mention already made. Only a NodeView is added;
 * the node spec is the server's, so the schemas stay identical. Until the name
 * arrives, and for someone the directory no longer knows, the chip shows the
 * label it was inserted with.
 */
import type { NodeViewRendererProps } from "@tiptap/react";
import { Mention } from "@stuga/crdt-ops";
import { onNamesResolved, personName, principalName, resolveNames } from "../state/identity";

export const MentionView = Mention.extend({
  addNodeView() {
    return (props: NodeViewRendererProps) => {
      const alias = String(props.node.attrs.alias);
      const label = `@${props.node.attrs.label}`;
      const dom = document.createElement("span");
      dom.className = "mention";
      dom.setAttribute("data-mention", "");
      dom.setAttribute("contenteditable", "false");
      const paint = () => {
        const name = personName(alias);
        const text = name ? `@${name}` : label;
        if (dom.textContent !== text) dom.textContent = text;
        // The handle it was inserted with, once the chip shows the name.
        dom.title = name ? label : principalName(`user:${alias}`);
      };
      paint();
      const unsubscribe = onNamesResolved(paint);
      resolveNames([`user:${alias}`]);
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) =>
          updated.type.name === props.node.type.name &&
          updated.attrs.alias === alias &&
          `@${updated.attrs.label}` === label,
        destroy: unsubscribe,
      };
    };
  },
});
