/**
 * Structure-preserving Markdown ↔ Yjs operations, shared by the browser (to
 * preview an edit) and the document actor (to apply it), so what the user
 * approves in the preview is exactly what lands. DOM-free at runtime.
 */
export { getStugaSchema, stugaExtensions, StugaCode } from "./schema.js";
export { FootnoteReference, FootnoteDefinition } from "./footnote-nodes.js";
export { Mention } from "./mention-node.js";
export { markdownToDoc } from "./markdown/parse.js";
export { docToMarkdown, EDITOR_ONLY_ATTRS } from "./markdown/serialize.js";
export { leavesFenceOpen, fencedLines } from "./markdown/fences.js";
export { yXmlFragmentToMarkdown, applyMarkdownToYXmlFragment } from "./bridge.js";
export {
  previewBlockSegments,
  blockDiffMarkdown,
  resolveSegment,
  topBlocks,
  type BlockDiffMarkdown,
} from "./diff/blocks.js";
export { wordDiff, type WordOp } from "./diff/words.js";
export { applyStrEditsStrict, computeStrEdits } from "./diff/str-edits.js";
export { charChangeCounts } from "./diff/char-counts.js";
export {
  applyCitedStrEdits,
  applyRenumberedStrEdits,
  reconcileFootnotes,
  denseFootnoteMap,
  type CitationInput,
} from "./footnotes.js";
