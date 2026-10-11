/**
 * The formatting toolbar: one row at every width. What does not fit moves into More, so a
 * narrow window, a wide side panel or a long translation never wraps it onto the page.
 * Controls prevent mousedown, so a click never takes the document's selection.
 */
import { useRef, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { HStack } from "@astryxdesign/core/HStack";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu, type DropdownMenuItemData, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link2,
  List as ListIcon,
  ListOrdered,
  ListTodo,
  Minus,
  Image as ImageIcon,
  Check,
  MoreHorizontal,
  Undo2,
  Redo2,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ArrowDownToLine,
  Trash2,
  Rows2,
  Rows3,
  Columns2,
  Table as TableIcon,
  TableCellsMerge,
  Paperclip,
} from "lucide-react";
import { useEditorTick } from "../use-editor-tick";
import { useElementWidth } from "../../lib/use-element-width";
import { historyCan, historyRedo, historyUndo } from "../run-preview/extension";
import { BlockTypeMenu } from "./BlockTypeMenu";
import { TableSizePicker } from "./TableSizePicker";
import { t } from "../../i18n/i18n";

const keepSelection = (e: React.MouseEvent) => e.preventDefault();

/**
 * How much of the toolbar shows at a width: everything; without underline, the less used lists
 * and the table; or, on a phone, text style, bold, italic, link, bullets and More.
 */
export type ToolbarFit = "full" | "compact" | "minimal";

/** The widths, in CSS pixels, below which the toolbar drops to the next fit; measured with German, the longest. */
const FULL_FROM = 640;
const COMPACT_FROM = 540;

/** The fit for the toolbar's width; 0 is not measured yet. */
export function fitFor(width: number): ToolbarFit {
  return width === 0 || width >= FULL_FROM ? "full" : width >= COMPACT_FROM ? "compact" : "minimal";
}


interface Control {
  title: string;
  icon: ReactNode;
  active: boolean;
  run: () => void;
}

function Mark({ control }: { control: Control }) {
  return (
    <ToggleButton
      label={control.title}
      tooltip={control.title}
      size="sm"
      isIconOnly
      icon={control.icon}
      isPressed={control.active}
      onPressedChange={control.run}
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
  onPickFiles,
}: {
  editor: Editor;
  onEditLink: () => void;
  /** Upload and insert files through the shared progress-tracked uploader: images as images, anything else as links. */
  onPickFiles: (files: File[]) => void;
}) {
  useEditorTick(editor);
  const chain = () => editor.chain().focus();
  const imageRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { ref: fitRef, width } = useElementWidth();
  const fit = fitFor(width);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // Lets the same file be picked again.
    e.target.value = "";
    if (files.length) onPickFiles(files);
  }

  const inTable = editor.isActive("table");
  const tick = (active: boolean) => (active ? <Check size={14} /> : undefined);

  const bold: Control = { title: t("editor.toolbar.bold", { shortcut: "⌘B" }), icon: <Bold size={16} />, active: editor.isActive("bold"), run: () => chain().toggleBold().run() };
  const italic: Control = { title: t("editor.toolbar.italic", { shortcut: "⌘I" }), icon: <Italic size={16} />, active: editor.isActive("italic"), run: () => chain().toggleItalic().run() };
  const underline: Control = { title: t("editor.toolbar.underline", { shortcut: "⌘U" }), icon: <Underline size={16} />, active: editor.isActive("underline"), run: () => chain().toggleUnderline().run() };
  const link: Control = { title: t("common.link"), icon: <Link2 size={16} />, active: editor.isActive("link"), run: onEditLink };
  const bullet: Control = { title: t("editor.blocks.bulletList"), icon: <ListIcon size={16} />, active: editor.isActive("bulletList"), run: () => chain().toggleBulletList().run() };
  const ordered: Control = { title: t("editor.blocks.numberedList"), icon: <ListOrdered size={16} />, active: editor.isActive("orderedList"), run: () => chain().toggleOrderedList().run() };
  const task: Control = { title: t("editor.blocks.taskList"), icon: <ListTodo size={16} />, active: editor.isActive("taskList"), run: () => chain().toggleTaskList().run() };
  const asItem = (c: Control): DropdownMenuItemData => ({ label: c.title, icon: c.icon, endContent: tick(c.active), onClick: c.run });

  // What the row has no room for comes first in More.
  const overflow: DropdownMenuItemData[] = [
    ...(fit === "full"
      ? []
      : [
          ...[underline, ordered, task].map(asItem),
          { label: t("editor.tableSize.insert"), icon: <TableIcon size={16} />, isDisabled: inTable, onClick: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
        ]),
    ...(fit === "minimal"
      ? [
          { label: t("editor.toolbar.undo", { shortcut: "⌘Z" }), icon: <Undo2 size={16} />, isDisabled: !historyCan(editor, "undo"), onClick: () => historyUndo(editor) },
          { label: t("editor.toolbar.redo", { shortcut: "⌘⇧Z" }), icon: <Redo2 size={16} />, isDisabled: !historyCan(editor, "redo"), onClick: () => historyRedo(editor) },
        ]
      : []),
  ];
  const more: DropdownMenuOption[] = [
    ...(overflow.length ? [...overflow, { type: "divider" as const }] : []),
    { label: t("editor.toolbar.strikethrough"), icon: <Strikethrough size={16} />, endContent: tick(editor.isActive("strike")), onClick: () => chain().toggleStrike().run() },
    { label: t("editor.toolbar.inlineCode"), icon: <Code size={16} />, endContent: tick(editor.isActive("code")), onClick: () => chain().toggleCode().run() },
    { type: "divider" },
    { label: t("editor.toolbar.insertImage"), icon: <ImageIcon size={16} />, onClick: () => imageRef.current?.click() },
    { label: t("editor.toolbar.insertFile"), icon: <Paperclip size={16} />, onClick: () => fileRef.current?.click() },
    { label: t("editor.blocks.divider"), icon: <Minus size={16} />, onClick: () => chain().setHorizontalRule().run() },
  ];

  // In the table button's place, so entering a table changes nothing else on the row.
  const tableTools = (
    <DropdownMenu
      renderTrigger={(props) => (
        <IconButton {...props} label={t("editor.toolbar.tableTools")} tooltip={t("editor.toolbar.tableTools")} variant="secondary" size="sm" icon={<TableIcon size={16} />} onMouseDown={keepSelection} />
      )}
      menuWidth={220}
      menuMaxHeight={520}
      presentation="adaptive"
      items={[
        { label: t("editor.toolbar.addColumnBefore"), icon: <ArrowLeftToLine size={16} />, onClick: () => chain().addColumnBefore().run() },
        { label: t("editor.toolbar.addColumnAfter"), icon: <ArrowRightToLine size={16} />, onClick: () => chain().addColumnAfter().run() },
        { label: t("editor.toolbar.addRowAbove"), icon: <ArrowUpToLine size={16} />, onClick: () => chain().addRowBefore().run() },
        { label: t("editor.toolbar.addRowBelow"), icon: <ArrowDownToLine size={16} />, onClick: () => chain().addRowAfter().run() },
        { type: "divider" },
        { label: t("editor.toolbar.toggleHeaderRow"), icon: <Rows3 size={16} />, onClick: () => chain().toggleHeaderRow().run() },
        { label: t("editor.toolbar.mergeOrSplit"), icon: <TableCellsMerge size={16} />, onClick: () => chain().mergeOrSplit().run() },
        { type: "divider" },
        { label: t("editor.toolbar.deleteRow"), icon: <Rows2 size={16} />, variant: "destructive", onClick: () => chain().deleteRow().run() },
        { label: t("editor.toolbar.deleteColumn"), icon: <Columns2 size={16} />, variant: "destructive", onClick: () => chain().deleteColumn().run() },
        { type: "divider" },
        { label: t("editor.toolbar.deleteTable"), icon: <Trash2 size={16} />, variant: "destructive", onClick: () => chain().deleteTable().run() },
      ]}
    />
  );

  return (
    <div ref={fitRef} className="editor-toolbar-fit" data-fit={fit}>
      <Toolbar
        label={t("editor.toolbar.label")}
        size="sm"
        startContent={
          <HStack gap={1} vAlign="center" wrap="nowrap">
            <BlockTypeMenu editor={editor} />
            {sep}

            <Mark control={bold} />
            <Mark control={italic} />
            {fit === "full" && <Mark control={underline} />}
            <Mark control={link} />
            {sep}

            <Mark control={bullet} />
            {fit === "full" && (
              <>
                <Mark control={task} />
                <Mark control={ordered} />
              </>
            )}
            {sep}

            {inTable ? tableTools : fit === "full" && <TableSizePicker editor={editor} />}
            <DropdownMenu
              button={{ label: t("editor.toolbar.more"), variant: "ghost", size: "sm", icon: <MoreHorizontal size={16} />, isIconOnly: fit === "minimal", tooltip: fit === "minimal" ? t("editor.toolbar.more") : undefined }}
              menuWidth={220}
              menuMaxHeight={520}
              presentation="adaptive"
              items={more}
            />

            {fit !== "minimal" && (
              <>
                {sep}
                {/* Through the review history, so an accept or reject undoes in turn with typing. */}
                <Action onRun={() => historyUndo(editor)} disabled={!historyCan(editor, "undo")} title={t("editor.toolbar.undo", { shortcut: "⌘Z" })} icon={<Undo2 size={16} />} />
                <Action onRun={() => historyRedo(editor)} disabled={!historyCan(editor, "redo")} title={t("editor.toolbar.redo", { shortcut: "⌘⇧Z" })} icon={<Redo2 size={16} />} />
              </>
            )}
            <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={onPick} />
            <input ref={fileRef} type="file" multiple hidden onChange={onPick} />
          </HStack>
        }
      />
    </div>
  );
}
