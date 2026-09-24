/** The ghost DOM a run hunk paints inline: struck/ghosted content plus its Accept/Reject pair. */
import type { EditorView } from "@tiptap/pm/view";
import { DOMSerializer, Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { WordOp } from "@stuga/crdt-ops";
import {
  RUN_HUNK_EVENT,
  type HunkKey,
  type HunkTotals,
  type PreviewHunkPart,
  type RunHunkDecisionDetail,
} from "./plan";

/** Blocks the body renders: footnote definitions are hidden there (FootnoteHide), so a ghost omits them too. */
function visibleBlocks(nodes: PMNode[]): PMNode[] {
  return nodes.filter((n) => n.type.name !== "footnoteDefinition");
}

/**
 * Accept/Reject for one hunk. Clicks go out as RUN_HUNK_EVENT; mousedown is
 * swallowed so ProseMirror doesn't move the selection into the widget. `pending`
 * disables both buttons, which stops a double-click from posting twice.
 */
function hunkActions(part: PreviewHunkPart, ordinal: number, total: number, pending: boolean): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ai-preview-hunk-actions";
  bar.setAttribute("contenteditable", "false");
  for (const decision of ["accept", "reject"] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ai-preview-hunk-btn ai-preview-hunk-btn--${decision}`;
    btn.textContent = decision === "accept" ? "Accept" : "Reject";
    btn.title = decision === "accept" ? "Apply this change" : "Discard this change";
    const verb = decision === "accept" ? "Accept" : "Reject";
    btn.setAttribute("aria-label", `${verb} change ${ordinal} of ${total}: ${part.summary}`);
    if (pending) {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    }
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      document.dispatchEvent(
        new CustomEvent<RunHunkDecisionDetail>(RUN_HUNK_EVENT, {
          detail: { runId: part.runId, hunkId: part.hunkId, decision },
        }),
      );
    });
    bar.appendChild(btn);
  }
  return bar;
}

/**
 * Column widths of the live table the segment sits in, so a ghosted row lines
 * up with the row it replaces. Null on any failure: a decoration factory must
 * not throw.
 */
function liveColumnWidths(view: EditorView | undefined, pos: number): number[] | null {
  if (!view) return null;
  try {
    const at = view.domAtPos(pos);
    const start = (at.node.nodeType === 1 ? at.node : at.node.parentNode) as HTMLElement | null;
    const table = start?.closest?.("table");
    // Skip a ghost's own rows: its shell row (by class) and its mini table's rows (by ancestry).
    const row = Array.from(table?.querySelectorAll("tr") ?? []).find(
      (r) => !r.classList.contains("ai-preview-ghost-row") && !r.closest(".ai-preview-ghost"),
    );
    if (!row || row.children.length === 0) return null;
    const widths = Array.from(row.children).map((c) => (c as HTMLElement).getBoundingClientRect().width);
    return widths.every((w) => w > 0) ? widths : null;
  } catch {
    return null;
  }
}

/** Shell for a ghost mounted among a table's rows: one <tr> whose cell spans every column. */
function rowGhostShell(ghost: HTMLElement, cols: number): HTMLElement {
  const tr = document.createElement("tr");
  tr.className = "ai-preview-ghost-row";
  tr.setAttribute("contenteditable", "false");
  const td = document.createElement("td");
  td.className = "ai-preview-ghost-cell";
  td.colSpan = cols;
  td.appendChild(ghost);
  tr.appendChild(td);
  return tr;
}

/** Wrap ghosted table rows in a table that mirrors the live column grid. */
function tableShell(widths: number[] | null): { host: HTMLElement; mount: HTMLElement } {
  const table = document.createElement("table");
  table.className = "ai-preview-ghost-table";
  if (widths) {
    const group = document.createElement("colgroup");
    for (const w of widths) {
      const col = document.createElement("col");
      col.style.width = `${w}px`;
      group.appendChild(col);
    }
    table.appendChild(group);
    table.style.tableLayout = "fixed";
    table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
  }
  const body = document.createElement("tbody");
  table.appendChild(body);
  return { host: table, mount: body };
}

/** Serialize the proposed blocks the body will show. */
function appendBlocks(target: HTMLElement, replacement: PMNode[], colWidths: number[] | null): void {
  const shown = visibleBlocks(replacement);
  if (shown.length === 0) return;
  const serializer = DOMSerializer.fromSchema(shown[0]!.type.schema);
  const fragment = serializer.serializeFragment(Fragment.fromArray(shown));
  if (shown.every((n) => n.type.spec.tableRole === "row")) {
    const { host, mount } = tableShell(colWidths);
    mount.appendChild(fragment);
    target.appendChild(host);
    return;
  }
  target.appendChild(fragment);
}

/** Inline word-level diff DOM: unchanged text plain, deletions struck, insertions ghosted. */
function appendWordDiff(target: HTMLElement, words: WordOp[]): void {
  for (const op of words) {
    if (op.type === "eq") {
      target.appendChild(document.createTextNode(op.text));
      continue;
    }
    const el = document.createElement(op.type === "del" ? "del" : "ins");
    el.className = op.type === "del" ? "ai-preview-delete" : "ai-preview-insert";
    el.textContent = op.text;
    target.appendChild(el);
  }
}

/** One hunk's slice of a ghost; `data-hunk-key` is how `scrollToHunk` finds it. */
function hunkPartDom(part: PreviewHunkPart, ordinal: number, total: number, pending: boolean, labeled: boolean, colWidths: number[] | null): HTMLElement {
  const el = document.createElement("div");
  el.className = "ai-preview-hunk";
  el.dataset.hunkKey = part.key;
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", `Change ${ordinal} of ${total}: ${part.summary}`);
  if (pending) {
    el.classList.add("ai-preview-hunk--pending");
    el.setAttribute("aria-busy", "true");
  }
  if (part.agent) {
    const who = document.createElement("span");
    who.className = "ai-preview-hunk-agent";
    who.textContent = part.agent;
    el.appendChild(who);
  }
  // In a merged ghost, the sub-label says which change each button pair decides.
  if (labeled) {
    const label = document.createElement("span");
    label.className = "ai-preview-hunk-label";
    label.textContent = part.summary;
    el.appendChild(label);
  }
  if (part.words) appendWordDiff(el, part.words);
  else appendBlocks(el, part.replacement, colWidths);
  el.appendChild(hunkActions(part, ordinal, total, pending));
  return el;
}

/** A ghost that inserts nothing visible, which must not wear the green "inserted" fill. */
function isRemovalOnly(parts: PreviewHunkPart[]): boolean {
  return parts.every((p) => !p.words && visibleBlocks(p.replacement).length === 0);
}

/**
 * Ghost DOM for the hunks sharing a region. The word and removal forms drop the
 * whole-block green fill: their del/ins spans or the struck text carry the change.
 */
export function runGhost(parts: PreviewHunkPart[], ordinals: Map<HunkKey, number>, total: HunkTotals, pendingKeys: ReadonlySet<HunkKey>, view?: EditorView, pos?: number, tableCols?: number | null): HTMLElement {
  const colWidths = pos === undefined ? null : liveColumnWidths(view, pos);
  const wordForm = parts.length === 1 && !!parts[0]!.words;
  const wrap = document.createElement("div");
  wrap.className = wordForm
    ? "ai-preview-ghost ai-preview-ghost--words"
    : isRemovalOnly(parts)
      ? "ai-preview-ghost ai-preview-ghost--removal"
      : "ai-preview-ghost ai-preview-insert ai-preview-insert--block";
  if (parts.length > 1) wrap.classList.add("ai-preview-ghost--merged");
  wrap.setAttribute("contenteditable", "false");
  for (const part of parts) {
    wrap.appendChild(
      hunkPartDom(part, ordinals.get(part.key) ?? 0, (total.get(part.key) ?? 0), pendingKeys.has(part.key), parts.length > 1, colWidths),
    );
  }
  return tableCols ? rowGhostShell(wrap, tableCols) : wrap;
}
