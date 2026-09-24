/** The formatting toolbar. Controls prevent mousedown, so a click never takes the document's selection. */
import { useRef, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { HStack } from "@astryxdesign/core/HStack";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import {
  Bold, Italic, Underline, Strikethrough, Code, Link2,
  List as ListIcon, ListOrdered, Quote, Minus, Image as ImageIcon, Check, MoreHorizontal,
  Undo2, Redo2,
  ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, ArrowDownToLine, Trash2, Rows3, TableCellsMerge,
} from "lucide-react";
import { useEditorTick } from "../use-editor-tick";
import { BlockTypeMenu } from "./BlockTypeMenu";
import { TableSizePicker } from "./TableSizePicker";

const keepSelection = (e: React.MouseEvent) => e.preventDefault();

function Mark({
  onRun,
  active,
  title,
  icon,
}: {
  onRun: () => void;
  active?: boolean;
  title: string;
  icon: ReactNode;
}) {
  return (
    <ToggleButton
      label={title}
      tooltip={title}
      size="sm"
      isIconOnly
      icon={icon}
      isPressed={!!active}
      onPressedChange={onRun}
      onMouseDown={keepSelection}
    />
  );
}

function Action({
  onRun,
  disabled,
  title,
  icon,
}: {
  onRun: () => void;
  disabled?: boolean;
  title: string;
  icon: ReactNode;
}) {
  return (
    <IconButton
      label={title}
      tooltip={title}
      variant="ghost"
      size="sm"
      icon={icon}
      isDisabled={disabled}
      onClick={onRun}
      onMouseDown={keepSelection}
    />
  );
}

const sep = <Divider orientation="vertical" />;

export function EditorToolbar({
  editor,
  onEditLink,
  onPickImages,
}: {
  editor: Editor;
  onEditLink: () => void;
  onPickImages: (files: File[]) => void;
}) {
  useEditorTick(editor);
  const chain = () => editor.chain().focus();
  const fileRef = useRef<HTMLInputElement>(null);

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // Lets the same file be picked again.
    e.target.value = "";
    if (files.length) onPickImages(files);
  }

  const inTable = editor.isActive("table");

  return (
    <Toolbar
      label="Formatting"
      size="sm"
      startContent={
        <HStack gap={1} vAlign="center" wrap="wrap">
          <BlockTypeMenu editor={editor} />
          {sep}

          <Mark onRun={() => chain().toggleBold().run()} active={editor.isActive("bold")} title="Bold (⌘B)" icon={<Bold size={16} />} />
          <Mark onRun={() => chain().toggleItalic().run()} active={editor.isActive("italic")} title="Italic (⌘I)" icon={<Italic size={16} />} />
          <Mark onRun={() => chain().toggleUnderline().run()} active={editor.isActive("underline")} title="Underline (⌘U)" icon={<Underline size={16} />} />
          <Mark onRun={onEditLink} active={editor.isActive("link")} title="Link" icon={<Link2 size={16} />} />
          {sep}

          <Mark onRun={() => chain().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Bullet list" icon={<ListIcon size={16} />} />
          <Mark onRun={() => chain().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Numbered list" icon={<ListOrdered size={16} />} />
          {sep}

          {!inTable && <TableSizePicker editor={editor} />}
          <DropdownMenu
            button={{ label: "Insert", variant: "ghost", size: "sm" }}
            menuWidth={180}
            presentation="adaptive"
            items={[
              { label: "Image…", icon: <ImageIcon size={16} />, onClick: () => fileRef.current?.click() },
              { label: "Divider", icon: <Minus size={16} />, onClick: () => chain().setHorizontalRule().run() },
            ]}
          />
          <DropdownMenu
            button={{ label: "More formatting", variant: "ghost", size: "sm", icon: <MoreHorizontal size={16} /> }}
            menuWidth={210}
            presentation="adaptive"
            items={[
              { label: "Strikethrough", icon: <Strikethrough size={16} />, endContent: editor.isActive("strike") ? <Check size={14} /> : undefined, onClick: () => chain().toggleStrike().run() },
              { label: "Inline code", icon: <Code size={16} />, endContent: editor.isActive("code") ? <Check size={14} /> : undefined, onClick: () => chain().toggleCode().run() },
              { label: "Quote", icon: <Quote size={16} />, endContent: editor.isActive("blockquote") ? <Check size={14} /> : undefined, onClick: () => chain().toggleBlockquote().run() },
            ]}
          />
          {sep}

          <Action onRun={() => chain().undo().run()} disabled={!editor.can().undo()} title="Undo (⌘Z)" icon={<Undo2 size={16} />} />
          <Action onRun={() => chain().redo().run()} disabled={!editor.can().redo()} title="Redo (⌘⇧Z)" icon={<Redo2 size={16} />} />
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPickImage} />

          {inTable && (
            <>
              {sep}
              <DropdownMenu
                button={{ label: "Table tools", variant: "secondary", size: "sm" }}
                menuWidth={220}
                presentation="adaptive"
                items={[
                  { label: "Add column before", icon: <ArrowLeftToLine size={16} />, onClick: () => chain().addColumnBefore().run() },
                  { label: "Add column after", icon: <ArrowRightToLine size={16} />, onClick: () => chain().addColumnAfter().run() },
                  { label: "Add row above", icon: <ArrowUpToLine size={16} />, onClick: () => chain().addRowBefore().run() },
                  { label: "Add row below", icon: <ArrowDownToLine size={16} />, onClick: () => chain().addRowAfter().run() },
                  { type: "divider" },
                  { label: "Toggle header row", icon: <Rows3 size={16} />, onClick: () => chain().toggleHeaderRow().run() },
                  { label: "Merge or split cells", icon: <TableCellsMerge size={16} />, onClick: () => chain().mergeOrSplit().run() },
                  { type: "divider" },
                  { label: "Delete row", variant: "destructive", onClick: () => chain().deleteRow().run() },
                  { label: "Delete column", variant: "destructive", onClick: () => chain().deleteColumn().run() },
                  { type: "divider" },
                  { label: "Delete table", icon: <Trash2 size={16} />, variant: "destructive", onClick: () => chain().deleteTable().run() },
                ]}
              />
            </>
          )}
        </HStack>
      }
    />
  );
}
