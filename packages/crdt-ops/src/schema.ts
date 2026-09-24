/**
 * The ProseMirror schema for Stuga documents, built from the same Tiptap
 * extensions the editor mounts, so a document produced here is node-for-node
 * compatible with the Y.XmlFragment the editor writes. Schema construction is
 * pure data; nothing here touches the DOM at runtime.
 */
import { getSchema, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Code } from "@tiptap/extension-code";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Image } from "@tiptap/extension-image";
import type { Schema } from "prosemirror-model";
import { FootnoteReference, FootnoteDefinition } from "./footnote-nodes.js";
import { Mention } from "./mention-node.js";

/**
 * The marks `code` refuses to share a text node with: exactly those markdown
 * cannot express inside backticks. `link` is allowed, because `` [`x`](url) ``
 * spells the link outside the span. `code` names itself because an explicit
 * `excludes` replaces the default self-exclusion. schema.test.ts pins the mark
 * set, so a new mark forces a decision about this list.
 */
export const CODE_EXCLUDES = "code bold italic strike underline";

/** StarterKit's `Code` with the exclusion above. Mounted after StarterKit so
 *  `link` out-ranks `code` and serializes as `` [`x`](url) ``. */
export const StugaCode = Code.extend({ excludes: CODE_EXCLUDES });

/**
 * The node/mark/attr set the live editor must match. Only schema-shaping config
 * belongs here; editor-only affordances (table and image resize handles) write
 * attrs this schema already declares.
 */
export function stugaExtensions(): Extensions {
  return [
    StarterKit.configure({ undoRedo: false, code: false }),
    StugaCode,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false }),
    FootnoteReference,
    FootnoteDefinition,
    Mention,
  ];
}

let cached: Schema | null = null;

export function getStugaSchema(): Schema {
  if (!cached) {
    cached = getSchema(stugaExtensions()) as unknown as Schema;
  }
  return cached;
}
