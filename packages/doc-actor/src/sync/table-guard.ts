/**
 * The table growth guard. Decided before a client update is applied, because a
 * Yjs integration cannot be undone: a 6000-column table, once merged and
 * broadcast, is permanent.
 */
import * as Y from "yjs";
import { MAX_TABLE_COLS, MAX_TABLE_ROWS } from "@stuga/protocol/domain/limits";

/** `table`, `tableRow`, `tableCell` and `tableHeader` all begin with this. */
const TABLE_TAG_PREFIX = "table";

/**
 * True when `update` provably cannot introduce table structure: Yjs writes
 * element tag names as plain ASCII, so without the bytes "table" no table node
 * can be created. False positives only cost the slow path. Deliberately not a
 * size heuristic — a minimal table-creating update is tiny, and its size depends
 * on a random client id.
 */
export function updateCannotGrowTable(update: Uint8Array): boolean {
  const needle = TABLE_TAG_PREFIX;
  const n = needle.length;
  if (update.byteLength < n) return true;
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + n <= update.byteLength; i++) {
    if (update[i] !== first) continue;
    for (let j = 1; j < n; j++) {
      if (update[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return false;
  }
  return true;
}

interface TableDims {
  cols: number;
  rows: number;
}

/**
 * Dimensions of every table in the fragment, in document order, so one table
 * shrinking cannot mask another growing. Width counts a row's cells, not
 * colspans: the runaway this bounds pads rows with literal empty cells.
 */
function tableDims(frag: Y.XmlFragment): TableDims[] {
  const out: TableDims[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment): void => {
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "table") {
        let cols = 0;
        let rows = 0;
        for (let r = 0; r < child.length; r++) {
          const row = child.get(r);
          if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow") continue;
          rows++;
          if (row.length > cols) cols = row.length;
        }
        out.push({ cols, rows });
        continue;
      }
      walk(child);
    }
  };
  walk(frag);
  return out;
}

/**
 * Whether `update` may land on `doc`: null, or the refusal. Measured by applying
 * it to a throwaway replica of the live document. `allowGrowth` consumes the
 * per-socket structural budget and is asked only for an update that grows a table.
 */
export function checkTableGrowth(
  doc: Y.Doc,
  update: Uint8Array,
  allowGrowth: () => boolean,
): "table-cap" | "structural-rate" | null {
  const pre = tableDims(doc.getXmlFragment("default"));
  // Ordinary typing: no table now, and none can appear.
  if (pre.length === 0 && updateCannotGrowTable(update)) return null;

  const probe = new Y.Doc();
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc), "preview");
    Y.applyUpdate(probe, update, "preview");
  } catch {
    // Malformed: let the real apply surface the error.
    return null;
  }
  const post = tableDims(probe.getXmlFragment("default"));

  for (const dims of post) {
    if (dims.cols > MAX_TABLE_COLS || dims.rows > MAX_TABLE_ROWS) return "table-cap";
  }

  // A table that only moved keeps its dimensions; a new or wider one is growth.
  let grew = post.length > pre.length;
  if (!grew) {
    for (let i = 0; i < post.length; i++) {
      const before = pre[i];
      const after = post[i]!;
      if (!before || after.cols > before.cols || after.rows > before.rows) {
        grew = true;
        break;
      }
    }
  }
  if (grew && !allowGrowth()) return "structural-rate";
  return null;
}
