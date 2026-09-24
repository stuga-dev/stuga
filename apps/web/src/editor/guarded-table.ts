/**
 * Tiptap's Table without prosemirror-tables' automatic repair of changes that
 * arrived from a peer. Repairing a peer's change writes padding into the CRDT,
 * which the next peer receives and pads again, growing the table without bound.
 * Local edits are still repaired. Plugins are not part of getSchema(), so the
 * shared schema is unchanged; the actor enforces its own table size ceilings.
 */
import { Table } from "@tiptap/extension-table";
import { Plugin, type EditorState, type Transaction } from "@tiptap/pm/state";
import { tableEditingKey } from "@tiptap/pm/tables";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

/**
 * A peer's change, or undo/redo replaying one. `isChangeOrigin` is checked
 * exactly: version-history rendering sets other meta under the same key.
 */
function isPeerSync(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: unknown } | undefined;
  return meta?.isChangeOrigin === true;
}

/**
 * Upstream normalizes the selection after `fixTables(state, oldState)`, which
 * only repairs where the two documents differ. Diffing peer traffic against
 * the new state itself skips the repair but keeps the normalization.
 */
function guardRepair(plugin: Plugin): Plugin {
  const upstream = plugin.spec.appendTransaction;
  // By identity: prosemirror-tables renames duplicate keys.
  if (plugin.spec.key !== tableEditingKey || !upstream) return plugin;

  return new Plugin({
    ...plugin.spec,
    appendTransaction(
      trs: readonly Transaction[],
      oldState: EditorState,
      newState: EditorState,
    ): Transaction | null | undefined {
      const baseline = trs.some(isPeerSync) ? newState : oldState;
      return upstream.call(this, trs, baseline, newState);
    },
  });
}

export const GuardedTable = Table.extend({
  addProseMirrorPlugins() {
    return (this.parent?.() ?? []).map(guardRepair);
  },
});
