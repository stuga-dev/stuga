/**
 * The Markdown ↔ CRDT bridge. Writing back mutates only the blocks whose content
 * differs (via y-tiptap's fragment diff), so a peer editing an untouched block
 * keeps its CRDT identity; `originalMarkdown` additionally narrows the proposal
 * to the range the AI changed, so concurrent edits elsewhere survive the turn.
 */
import * as Y from "yjs";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { getStugaSchema } from "./schema.js";
import { markdownToDoc } from "./markdown/parse.js";
import { docToMarkdown } from "./markdown/serialize.js";
import { topBlocks, docNode, mergeTarget } from "./diff/blocks.js";

interface ApplyOptions {
  /** Defaults to the Stuga schema. */
  schema?: Schema;
  /** Yjs transaction origin. */
  origin?: unknown;
  /** Markdown the proposal was written against; enables the 3-way merge with the current document. */
  originalMarkdown?: string | null;
}

/**
 * The fragment as a document. A fragment nobody has written to is an empty document: the binding
 * refuses to build one, since the schema wants a block. Content the schema cannot hold throws.
 */
function yXmlFragmentToDoc(frag: Y.XmlFragment, schema: Schema = getStugaSchema()): PMNode {
  return frag.length === 0 ? schema.topNodeType.create() : (yXmlFragmentToProseMirrorRootNode(frag, schema) as PMNode);
}

/** CRDT → Markdown: the projection an AI turn, an MCP read, and RAG all see. */
export function yXmlFragmentToMarkdown(frag: Y.XmlFragment, schema: Schema = getStugaSchema()): string {
  return docToMarkdown(yXmlFragmentToDoc(frag, schema));
}

/** Markdown → CRDT: apply a proposal to the fragment in place, minimally. */
export function applyMarkdownToYXmlFragment(
  frag: Y.XmlFragment,
  proposedMarkdown: string,
  opts: ApplyOptions = {},
): void {
  const schema = opts.schema ?? getStugaSchema();
  const proposed = markdownToDoc(proposedMarkdown, schema);

  let target: PMNode;
  if (opts.originalMarkdown != null) {
    const current = yXmlFragmentToDoc(frag, schema);
    const original = markdownToDoc(opts.originalMarkdown, schema);
    target = mergeTarget(schema, current, original, proposed);
  } else {
    target = docNode(schema, topBlocks(proposed));
  }

  const ydoc = frag.doc;
  const apply = () => {
    prosemirrorToYXmlFragment(target, frag);
  };
  if (ydoc) ydoc.transact(apply, opts.origin);
  else apply();
}
