/** The toolbar's block type menu, labelled with the block the cursor is in. */
import type { Editor } from "@tiptap/react";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Check } from "lucide-react";

interface BlockType {
  id: string;
  label: string;
  /** Does the cursor currently sit in this block type? */
  isActive: (e: Editor) => boolean;
  /** Switch the current block to this type. */
  apply: (e: Editor) => void;
}

// Menu order.
const PARAGRAPH: BlockType = { id: "paragraph", label: "Normal text", isActive: (e) => e.isActive("paragraph"), apply: (e) => e.chain().focus().setParagraph().run() };
const TYPES: BlockType[] = [
  PARAGRAPH,
  { id: "h1", label: "Heading 1", isActive: (e) => e.isActive("heading", { level: 1 }), apply: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", isActive: (e) => e.isActive("heading", { level: 2 }), apply: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", isActive: (e) => e.isActive("heading", { level: 3 }), apply: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: "bullet", label: "Bullet list", isActive: (e) => e.isActive("bulletList"), apply: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ordered", label: "Numbered list", isActive: (e) => e.isActive("orderedList"), apply: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "quote", label: "Quote", isActive: (e) => e.isActive("blockquote"), apply: (e) => e.chain().focus().toggleBlockquote().run() },
  // Before "Code block", which also matches a mermaid block: the first match labels the trigger.
  { id: "mermaid", label: "Mermaid diagram", isActive: (e) => e.isActive("codeBlock", { language: "mermaid" }), apply: (e) => e.chain().focus().setCodeBlock({ language: "mermaid" }).run() },
  { id: "code", label: "Code block", isActive: (e) => e.isActive("codeBlock"), apply: (e) => e.chain().focus().toggleCodeBlock().run() },
];

export function BlockTypeMenu({ editor }: { editor: Editor }) {
  const current = TYPES.find((t) => t.id !== "paragraph" && t.isActive(editor)) ?? PARAGRAPH;

  return (
    <DropdownMenu
      button={{ label: current.label, variant: "ghost", size: "sm" }}
      hasChevron
      menuWidth={180}
      items={TYPES.map((t) => ({
        label: t.label,
        icon: t.isActive(editor) ? <Check size={16} /> : undefined,
        onClick: () => t.apply(editor),
      }))}
    />
  );
}
