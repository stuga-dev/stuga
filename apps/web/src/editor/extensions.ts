/**
 * Everything the collaborative editor mounts. The node/mark/attr set must match
 * `getStugaSchema()` from @stuga/crdt-ops (extensions.test.ts asserts it): the
 * same CRDT is written by this editor and by headless server-side edits.
 */
import type { Extensions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Link } from "@tiptap/extension-link";
import Collaboration from "@tiptap/extension-collaboration";
import { Placeholder } from "@tiptap/extensions";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Image } from "@tiptap/extension-image";
import { Markdown } from "tiptap-markdown";
import { FootnoteDefinition, StugaCode } from "@stuga/crdt-ops";
import { MentionView } from "./mention-node-view";
import type * as Y from "yjs";
import { colorFor } from "../state/identity";
import { PeerCarets } from "./peer-carets";
import { MermaidCodeBlock } from "./mermaid-code-block";
import { GuardedTable } from "./guarded-table";
import { FootnoteReferenceView } from "./footnote-node-view";
import { FootnoteHide } from "./footnote-hide";
import { ImageCaption } from "./image-caption";
import { withImageSizeSync } from "./image-resize-sync";
import { RunPreview } from "./run-preview/extension";
import { CommentHighlight } from "../comments/comment-highlight";

// A link ends at its boundary, so typing after an autolinked URL is plain text.
// `inclusive` is editing behaviour, not part of the schema.
const StugaLink = Link.extend({ inclusive: () => false });

// tiptap-markdown adds a browser-only `tight` attr to both list types. The server
// schema has no such attr, so every server-side commit would flip loose lists to
// tight and every loose list would read as a concurrent edit. The sub-extension
// stays mounted but attaches the attr to nothing; the paste and insertContent
// markdown parsing it provides is still needed.
const TIGHT_LISTS_EXTENSION = "markdownTightLists";
const StugaMarkdown = Markdown.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((ext) =>
      ext.name === TIGHT_LISTS_EXTENSION ? ext.configure({ listTypes: [] }) : ext,
    );
  },
});

/** The mounted order matters: mark rank follows it, and rank decides mark nesting on markdown export. */
export function stugaEditorExtensions(deps: {
  ydoc: Y.Doc;
  awareness: unknown;
  alias: string;
  label?: string;
  onClickComment: (num: number) => void;
}): Extensions {
  return [
    StarterKit.configure({
      // Collaboration owns history.
      undoRedo: false,
      link: false,
      codeBlock: false,
      code: false,
      // Lists and quotes take the direction of their first text, so an Arabic list has its
      // markers on the right. Rendered attributes only, never node attrs; editor.css gives
      // every other block the direction of its own text.
      bulletList: { HTMLAttributes: { dir: "auto" } },
      orderedList: { HTMLAttributes: { dir: "auto" } },
      blockquote: { HTMLAttributes: { dir: "auto" } },
    }),
    // After StarterKit, so `link` out-ranks `code` and a linked code span exports as [`x`](url).
    StugaCode,
    MermaidCodeBlock,
    GuardedTable.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    // `inline` flips the image node's group, so it must stay false as on the server; `resize` is view-only.
    Image.configure({ inline: false, resize: { enabled: true, minWidth: 48, alwaysPreserveAspectRatio: true } }).extend({
      addNodeView() {
        return withImageSizeSync(this.parent?.());
      },
    }),
    // Clicking a link places the caret; LinkPopover's Open navigates.
    StugaLink.configure({ openOnClick: false }),
    StugaMarkdown.configure({ html: false, transformPastedText: true }),
    // Accepted agent edits arrive as remote updates, outside Ctrl+Z; the run bar's Undo reverts them.
    Collaboration.configure({ document: deps.ydoc, field: "default" }),
    PeerCarets.configure({
      provider: { awareness: deps.awareness } as never,
      // `label` rides along in awareness for the presence tooltip; `color` must be 6-digit hex.
      user: { name: deps.alias, label: deps.label ?? deps.alias, color: colorFor(deps.alias) },
    }),
    CommentHighlight.configure({
      ydoc: deps.ydoc,
      onClickComment: (num: number) => deps.onClickComment(num),
    }),
    FootnoteReferenceView,
    FootnoteDefinition,
    MentionView,
    FootnoteHide,
    ImageCaption,
    RunPreview.configure({ ydoc: deps.ydoc }),
    // Decorations only, never the document. editor.css shows the hint on an empty document once it has synced.
    Placeholder.configure({ placeholder: "Start writing here…", showOnlyWhenEditable: true }),
  ];
}
