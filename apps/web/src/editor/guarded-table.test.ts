/**
 * The real mounted plugin over real ragged tables, asserting on cell counts.
 * The control case proves the fixture provokes a repair at all.
 */
import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, NodeSelection, type Transaction } from "@tiptap/pm/state";
import { CellSelection, tableEditing, tableEditingKey, columnResizing } from "@tiptap/pm/tables";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { getStugaSchema } from "@stuga/crdt-ops";
import { GuardedTable } from "./guarded-table";

/** The production schema, so a guard that perturbed it would show. */
const schema = getStugaSchema();

function cell(text = ""): PMNode {
  const content = text ? [schema.nodes.paragraph!.create(null, schema.text(text))] : [schema.nodes.paragraph!.create()];
  return schema.nodes.tableCell!.create(null, content);
}

/** Rows of different widths, as concurrent edits leave them. */
function raggedDoc(widths: number[]): PMNode {
  const rows = widths.map((w) =>
    schema.nodes.tableRow!.create(
      null,
      Array.from({ length: w }, (_, i) => cell(`c${i}`)),
    ),
  );
  return schema.nodes.doc!.create(null, [
    schema.nodes.table!.create(null, rows),
    schema.nodes.paragraph!.create(),
  ]);
}

/** Table cells and headers in a doc. */
function countCells(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") n++;
  });
  return n;
}

/** GuardedTable's plugins, mounted as the editor mounts them. */
function mountPlugins() {
  return GuardedTable.configure({ resizable: true }).config.addProseMirrorPlugins!.call({
    parent: () => [columnResizing({}), tableEditing({})],
    options: { resizable: true, allowTableNodeSelection: false },
    editor: { isEditable: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/** The table-editing plugin GuardedTable mounts. */
function guardedPlugin() {
  const plugin = mountPlugins().find((p) => p.spec.key === tableEditingKey);
  if (!plugin) throw new Error("GuardedTable did not mount the tableEditing plugin");
  return plugin;
}

/**
 * The states are built without the plugin, since `state.apply()` would run the
 * repair itself and make every count post-repair.
 */
function statesFor(opts: { peer?: boolean; undoRedo?: boolean; widths?: number[] }): {
  state: EditorState;
  newState: EditorState;
  tr: Transaction;
} {
  const widths = opts.widths ?? [3, 1];
  // Raggedness must arrive as a change: fixTables scans only what differs.
  const state = EditorState.create({ schema, doc: raggedDoc([1, 1]) });
  const tr = state.tr.replaceWith(0, state.doc.child(0).nodeSize, raggedDoc(widths).child(0));
  if (opts.peer) {
    tr.setMeta(ySyncPluginKey, {
      isChangeOrigin: true,
      ...(opts.undoRedo ? { isUndoRedoOperation: true } : {}),
    });
  }
  return { state, newState: state.apply(tr), tr };
}

/** Cell counts before and after the appended transaction. */
function runAppend(
  plugin: ReturnType<typeof guardedPlugin>,
  opts: { peer?: boolean; undoRedo?: boolean; widths?: number[] } = {},
): { before: number; after: number; appended: Transaction | null | undefined } {
  const { state, newState, tr } = statesFor(opts);
  const before = countCells(newState.doc);
  const appended = plugin.spec.appendTransaction?.call(plugin, [tr], state, newState);
  const after = appended ? countCells(newState.apply(appended).doc) : before;
  return { before, after, appended };
}

describe("table repair guard", () => {
  it("control: upstream tableEditing pads a ragged table", () => {
    const { before, after } = runAppend(tableEditing({}) as ReturnType<typeof guardedPlugin>);
    expect(after).toBeGreaterThan(before);
  });

  it("leaves a ragged table alone when the change came from a peer", () => {
    const { before, after } = runAppend(guardedPlugin(), { peer: true });
    expect(after).toBe(before);
  });

  it("still pads a ragged table the local user produced", () => {
    const { before, after } = runAppend(guardedPlugin(), { peer: false });
    expect(after).toBeGreaterThan(before);
  });

  it("treats a batch mixing local and peer changes as peer traffic", () => {
    // One padded row is enough to start the growth.
    const plugin = guardedPlugin();
    const state = EditorState.create({ schema, doc: raggedDoc([1, 1]) });
    const local = state.tr.insertText("x", state.doc.content.size - 1);
    const peer = state.tr.replaceWith(0, state.doc.child(0).nodeSize, raggedDoc([3, 1]).child(0));
    peer.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    const newState = state.apply(peer);
    const before = countCells(newState.doc);
    const appended = plugin.spec.appendTransaction?.call(plugin, [local, peer], state, newState);
    const after = appended ? countCells(newState.apply(appended).doc) : before;
    expect(after).toBe(before);
  });

  it("keeps repairing while version history renders (ySync meta with no isChangeOrigin)", () => {
    const plugin = guardedPlugin();
    const state = EditorState.create({ schema, doc: raggedDoc([1, 1]) });
    const tr = state.tr.replaceWith(0, state.doc.child(0).nodeSize, raggedDoc([3, 1]).child(0));
    tr.setMeta(ySyncPluginKey, { snapshot: {}, prevSnapshot: {} });
    const newState = state.apply(tr);
    const before = countCells(newState.doc);
    const appended = plugin.spec.appendTransaction?.call(plugin, [tr], state, newState);
    const after = appended ? countCells(newState.apply(appended).doc) : before;
    expect(after).toBeGreaterThan(before);
  });

  it("treats undo and redo as peer traffic", () => {
    // Repairing on undo would commit padding to the CRDT, and history holds normalized documents.
    const { before, after } = runAppend(guardedPlugin(), { peer: true, undoRedo: true });
    expect(after).toBe(before);
  });

  it("normalizes the selection even when repair is skipped", () => {
    // A NodeSelection on a tableRow must come back as a CellSelection.
    const plugin = guardedPlugin();
    const state0 = EditorState.create({ schema, doc: raggedDoc([2, 2]) });
    const rowPositions: number[] = [];
    state0.doc.descendants((node, pos) => {
      if (node.type.name === "tableRow") rowPositions.push(pos);
    });
    const withSel = state0.apply(state0.tr.setSelection(NodeSelection.create(state0.doc, rowPositions[0]!)));
    expect(withSel.selection).not.toBeInstanceOf(CellSelection);

    const tr = withSel.tr.insertText("x", withSel.doc.content.size - 1);
    tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    const newState = withSel.apply(tr);

    const appended = plugin.spec.appendTransaction?.call(plugin, [tr], withSel, newState);
    expect(appended, "normalization must still produce a transaction").toBeTruthy();
    const final = newState.apply(appended!);
    expect(final.selection).toBeInstanceOf(CellSelection);
  });

  it("passes columnResizing through untouched", () => {
    const plugins = mountPlugins();
    expect(plugins).toHaveLength(2);
    expect(plugins[0]!.spec.key).toStrictEqual(columnResizing({}).spec.key);
  });

  it("identifies the table plugin by key identity, not by key name", () => {
    // prosemirror-tables suffixes duplicate key names with `$N`.
    expect(guardedPlugin().spec.key).toBe(tableEditingKey);
  });
});

describe("schema separation", () => {
  it("leaves the schema's table nodes intact", () => {
    expect(Object.keys(schema.nodes)).toContain("table");
    expect(Object.keys(schema.nodes)).toContain("tableRow");
    expect(Object.keys(schema.nodes)).toContain("tableCell");
    expect(Object.keys(schema.nodes)).toContain("tableHeader");
  });
});
