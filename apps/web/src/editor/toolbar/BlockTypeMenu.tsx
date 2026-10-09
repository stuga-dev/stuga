/** The toolbar's block type menu, labelled with the block the cursor is in. */
import type { Editor } from "@tiptap/react";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Check } from "lucide-react";
import { t, type MessageKey } from "../../i18n/i18n";

interface BlockType {
  id: string;
  labelKey: MessageKey;
  /** Does the cursor currently sit in this block type? */
  isActive: (e: Editor) => boolean;
  /** Switch the current block to this type. */
  apply: (e: Editor) => void;
}

// Menu order.
const PARAGRAPH: BlockType = { id: "paragraph", labelKey: "editor.blocks.normalText", isActive: (e) => e.isActive("paragraph"), apply: (e) => e.chain().focus().setParagraph().run() };
const TYPES: BlockType[] = [
  PARAGRAPH,
  { id: "h1", labelKey: "editor.blocks.heading1", isActive: (e) => e.isActive("heading", { level: 1 }), apply: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: "h2", labelKey: "editor.blocks.heading2", isActive: (e) => e.isActive("heading", { level: 2 }), apply: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: "h3", labelKey: "editor.blocks.heading3", isActive: (e) => e.isActive("heading", { level: 3 }), apply: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: "bullet", labelKey: "editor.blocks.bulletList", isActive: (e) => e.isActive("bulletList"), apply: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ordered", labelKey: "editor.blocks.numberedList", isActive: (e) => e.isActive("orderedList"), apply: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "quote", labelKey: "editor.blocks.quote", isActive: (e) => e.isActive("blockquote"), apply: (e) => e.chain().focus().toggleBlockquote().run() },
  // Before "Code block", which also matches a mermaid block: the first match labels the trigger.
  { id: "mermaid", labelKey: "editor.blocks.mermaid", isActive: (e) => e.isActive("codeBlock", { language: "mermaid" }), apply: (e) => e.chain().focus().setCodeBlock({ language: "mermaid" }).run() },
  { id: "code", labelKey: "editor.blocks.codeBlock", isActive: (e) => e.isActive("codeBlock"), apply: (e) => e.chain().focus().toggleCodeBlock().run() },
];

export function BlockTypeMenu({ editor }: { editor: Editor }) {
  const current = TYPES.find((type) => type.id !== "paragraph" && type.isActive(editor)) ?? PARAGRAPH;

  return (
    <DropdownMenu
      button={{ label: t(current.labelKey), variant: "ghost", size: "sm" }}
      hasChevron
      menuWidth={180}
      items={TYPES.map((type) => ({
        label: t(type.labelKey),
        icon: type.isActive(editor) ? <Check size={16} /> : undefined,
        onClick: () => type.apply(editor),
      }))}
    />
  );
}
