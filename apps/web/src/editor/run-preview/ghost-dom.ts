/** The ghost DOM a run hunk paints inline: struck/ghosted content plus its Accept, Reject and note. */
import type { EditorView } from "@tiptap/pm/view";
import { DOMSerializer, Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { WordOp } from "@stuga/crdt-ops";
import {
  RUN_HUNK_EVENT,
  type HunkKey,
  type HunkTotals,
  type PartRole,
  type PreviewHunkPart,
  type RunHunkDecisionDetail,
} from "./plan";
import { RUN_FEEDBACK_NOTE_MAX_CHARS } from "@stuga/protocol/domain/limits";
import { noteLabels } from "../../review/note-mode";
import { isComposingKey } from "../../lib/ime";
import { t, type MessageKey } from "../../i18n/i18n";

/** What a decision button, or a note's send button, does: each names its change in a sentence of its own. */
type DecisionLabel = "accept" | "reject" | "revise" | "withNote";

const CHANGE_LABELS: Record<DecisionLabel, MessageKey> = {
  accept: "editor.runPreview.acceptChange",
  reject: "editor.runPreview.rejectChange",
  revise: "editor.runPreview.reviseChange",
  withNote: "editor.runPreview.noteChange",
};

/** The note's own action, as `noteLabels` words its send button: Revise for the co-author's run, Reject with note otherwise. */
function noteDecision(part: PreviewHunkPart): DecisionLabel {
  return part.noteMode === "revise" ? "revise" : "withNote";
}

function changeLabel(decision: DecisionLabel, part: PreviewHunkPart, ordinal: number, total: number): string {
  return t(CHANGE_LABELS[decision], { ordinal, total, summary: part.summary });
}

/** Blocks the body renders: footnote definitions are hidden there (FootnoteHide), so a ghost omits them too. */
function visibleBlocks(nodes: PMNode[]): PMNode[] {
  return nodes.filter((n) => n.type.name !== "footnoteDefinition");
}

interface Draft {
  text: string;
  /** The note has the focus, or had it when a repaint removed its field. */
  focused: boolean;
  /** Just opened by its button: the field takes the focus from wherever it is. */
  opening?: boolean;
  /** The field it is written in, whose caret and selection a rebuilt field takes over. */
  field?: HTMLTextAreaElement;
}

/**
 * Notes being written in a change's row, by hunk key. A repaint (a collaborator's edit, another
 * change decided) builds the row anew, and the note, and the caret in it, must survive that; so must
 * a sent note whose decision doesn't land. `keepDrafts` drops a note once its change is decided.
 */
const drafts = new Map<HunkKey, Draft>();

/** Drop the notes of changes no longer pending: decided some other way, a note must not come back with them. */
export function keepDrafts(keys: ReadonlySet<HunkKey>): void {
  for (const key of drafts.keys()) if (!keys.has(key)) drafts.delete(key);
}

/** The note mid-composition (an input method's candidate not yet picked), and the repaint held back meanwhile. */
let composing: { field: HTMLTextAreaElement; held: (() => void) | null } | null = null;

/** True while a note is mid-composition, which a rebuilt ghost would end: keep the ghosts, and `repaint` runs once it ends. */
export function holdWhileComposing(repaint: () => void): boolean {
  if (!composing?.field.isConnected) return false;
  composing.held = repaint;
  return true;
}

/** Whether focus fell to the page, as it does when the element holding it is removed. */
function focusDropped(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

function sendHunkEvent(detail: RunHunkDecisionDetail): void {
  document.dispatchEvent(new CustomEvent<RunHunkDecisionDetail>(RUN_HUNK_EVENT, { detail }));
}

/**
 * One hunk's decision: Accept, Reject and the note button, which opens the note in place of the
 * row. `pending` disables the buttons, which stops a double-click from posting twice. A hunk painted
 * in `parts` places says the buttons decide all of them.
 */
function hunkActions(part: PreviewHunkPart, ordinal: number, total: number, pending: boolean, parts: number): HTMLElement {
  const holder = document.createElement("div");
  holder.className = "ai-preview-hunk-decide";
  holder.setAttribute("contenteditable", "false");
  const show = (writing: boolean): void => {
    if (writing) {
      holder.replaceChildren(noteComposer(part, ordinal, total, () => {
        show(false);
        holder.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--request_changes")?.focus({ preventScroll: true });
      }));
      return;
    }
    holder.replaceChildren(
      decisionRow(part, ordinal, total, pending, parts, () => {
        drafts.set(part.key, { text: "", focused: true, opening: true });
        show(true);
      }),
    );
  };
  show(!pending && drafts.has(part.key));
  return holder;
}

/** Clicks go out as RUN_HUNK_EVENT; mousedown is swallowed so ProseMirror doesn't move the selection into the widget. */
function decisionRow(
  part: PreviewHunkPart,
  ordinal: number,
  total: number,
  pending: boolean,
  parts: number,
  openNote: () => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ai-preview-hunk-actions";
  let scope: HTMLElement | null = null;
  if (parts > 1) {
    scope = document.createElement("span");
    scope.className = "ai-preview-hunk-scope";
    scope.id = `ai-preview-scope-${part.key}`;
    scope.textContent = t("editor.runPreview.appliesToParts", { count: parts });
  }
  const note = noteLabels(part.noteMode ?? "agent");
  const LABELS: Record<"accept" | "reject" | "request_changes", { text: string; title: string; label: DecisionLabel }> = {
    accept: { text: t("common.accept"), title: t("editor.runPreview.acceptTitle"), label: "accept" },
    reject: { text: t("common.reject"), title: t("editor.runPreview.rejectTitle"), label: "reject" },
    request_changes: {
      text: note.trigger,
      title: part.noteMode === "revise" ? t("editor.runPreview.reviseTitle") : t("editor.runPreview.noteTitle"),
      label: noteDecision(part),
    },
  };
  for (const decision of ["accept", "reject", "request_changes"] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ai-preview-hunk-btn ai-preview-hunk-btn--${decision}`;
    btn.textContent = LABELS[decision].text;
    btn.title = LABELS[decision].title;
    btn.setAttribute("aria-label", changeLabel(LABELS[decision].label, part, ordinal, total));
    if (scope) btn.setAttribute("aria-describedby", scope.id);
    if (pending) {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    }
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      if (decision === "request_changes") openNote();
      else sendHunkEvent({ runId: part.runId, hunkId: part.hunkId, decision });
    });
    bar.appendChild(btn);
  }
  if (scope) bar.appendChild(scope);
  return bar;
}

/**
 * The note, written where the buttons were: Enter sends, Shift+Enter breaks a line, Escape closes.
 * Its send button says what the trigger said, so the reviewer confirms the action they chose.
 */
function noteComposer(part: PreviewHunkPart, ordinal: number, total: number, close: () => void): HTMLElement {
  const labels = noteLabels(part.noteMode ?? "agent");
  const draft: Draft = drafts.get(part.key) ?? { text: "", focused: true };
  drafts.set(part.key, draft);

  const box = document.createElement("div");
  box.className = "ai-preview-hunk-note";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", changeLabel(noteDecision(part), part, ordinal, total));

  const field = document.createElement("textarea");
  field.className = "ai-preview-hunk-note__field";
  field.rows = 2;
  field.dir = "auto";
  field.placeholder = t("editor.runPreview.notePlaceholder");
  field.setAttribute("aria-label", t("editor.runPreview.notePlaceholder"));
  field.maxLength = RUN_FEEDBACK_NOTE_MAX_CHARS;
  field.value = draft.text;
  // The caret and selection of the field this one replaces, which a detached field still holds.
  const prev = draft.field;
  if (prev) field.setSelectionRange(prev.selectionStart, prev.selectionEnd, prev.selectionDirection ?? "none");
  draft.field = field;

  const foot = document.createElement("div");
  foot.className = "ai-preview-hunk-note__foot";
  if (labels.hint) {
    const hint = document.createElement("span");
    hint.className = "ai-preview-hunk-note__hint";
    hint.textContent = labels.hint;
    foot.appendChild(hint);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ai-preview-hunk-btn ai-preview-hunk-btn--cancel";
  cancel.textContent = t("common.cancel");
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "ai-preview-hunk-btn ai-preview-hunk-btn--submit";
  submit.textContent = labels.submit;
  submit.disabled = !draft.text.trim();
  foot.append(cancel, submit);
  box.append(field, foot);

  const dismiss = (): void => {
    drafts.delete(part.key);
    close();
  };
  // The draft stays until the change leaves review (keepDrafts), so a rejection that fails paints
  // the note back, as written.
  const send = (): void => {
    const note = field.value.trim();
    if (!note) return;
    sendHunkEvent({ runId: part.runId, hunkId: part.hunkId, decision: "request_changes", note });
  };
  field.addEventListener("input", () => {
    draft.text = field.value;
    submit.disabled = !field.value.trim();
  });
  field.addEventListener("focus", () => {
    draft.focused = true;
  });
  // A field removed by a repaint may report a blur; the rebuilt one takes the focus back.
  field.addEventListener("blur", () => {
    if (field.isConnected) draft.focused = false;
  });
  field.addEventListener("keydown", (e) => {
    // An input method's Enter picks a candidate and its Escape drops one: neither is the note's.
    if (isComposingKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  });
  field.addEventListener("compositionstart", () => {
    composing = { field, held: null };
  });
  field.addEventListener("compositionend", () => {
    if (composing?.field !== field) return;
    const { held } = composing;
    composing = null;
    // Once the events that end it have landed: Safari's Enter comes after this one.
    if (held) setTimeout(held, 0);
  });
  for (const btn of [cancel, submit]) btn.addEventListener("mousedown", (e) => e.preventDefault());
  cancel.addEventListener("click", dismiss);
  submit.addEventListener("click", send);

  if (draft.focused) {
    requestAnimationFrame(() => {
      // Built anew, the note takes back only the focus its removal dropped, never one moved elsewhere since.
      if (!field.isConnected || !(draft.opening || focusDropped())) return;
      draft.opening = false;
      const { selectionStart, selectionEnd, selectionDirection } = field;
      field.focus({ preventScroll: true });
      field.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? "none");
    });
  }
  return box;
}

/** True for an event inside a change's note, which is the field's to handle, not ProseMirror's. */
export function isInHunkNote(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(".ai-preview-hunk-note") !== null;
}

/**
 * Ends a part of a hunk painted in several places, apart from its last: the buttons are at the
 * last part, and Go to decision takes the reviewer (and keyboard focus) there.
 */
function partNote(part: PreviewHunkPart, role: PartRole): HTMLElement {
  const note = document.createElement("div");
  note.className = "ai-preview-hunk-part";
  note.setAttribute("contenteditable", "false");
  note.appendChild(document.createTextNode(t("editor.runPreview.part", { index: role.index, parts: role.parts })));
  const go = document.createElement("button");
  go.type = "button";
  go.className = "ai-preview-hunk-goto";
  go.textContent = t("editor.runPreview.goToDecision");
  go.addEventListener("mousedown", (e) => e.preventDefault());
  go.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const root = go.closest(".ProseMirror") ?? document;
    const own = Array.from(root.querySelectorAll<HTMLElement>(".ai-preview-hunk")).filter((el) => el.dataset.hunkKey === part.key);
    const accept = own[own.length - 1]?.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--accept");
    if (!accept) return;
    accept.scrollIntoView({ block: "center", behavior: "smooth" });
    accept.focus({ preventScroll: true });
  });
  note.appendChild(go);
  return note;
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
function hunkPartDom(
  part: PreviewHunkPart,
  ordinal: number,
  total: number,
  pending: boolean,
  labeled: boolean,
  colWidths: number[] | null,
  role: PartRole,
  body: boolean,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "ai-preview-hunk";
  el.dataset.hunkKey = part.key;
  el.setAttribute("role", "group");
  el.setAttribute(
    "aria-label",
    role.parts > 1
      ? t("editor.runPreview.changePart", { ordinal, total, index: role.index, parts: role.parts, summary: part.summary })
      : t("editor.runPreview.change", { ordinal, total, summary: part.summary }),
  );
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
  // Without a body the change is drawn on the live text, and only the buttons go here.
  if (body && part.words) appendWordDiff(el, part.words);
  else if (body) appendBlocks(el, part.replacement, colWidths);
  if (role.kind === "final") el.appendChild(hunkActions(part, ordinal, total, pending, role.parts));
  else if (role.kind === "part") el.appendChild(partNote(part, role));
  return el;
}

const SOLE: PartRole = { kind: "final", index: 1, parts: 1 };

/**
 * Whether a segment's ghost would show nothing: every hunk in it continues into the next segment
 * (so carries no buttons), and its change is drawn on the live text or inserts nothing.
 */
export function ghostIsEmpty(parts: PreviewHunkPart[], inline: boolean, roles: ReadonlyMap<HunkKey, PartRole>): boolean {
  return parts.every((p) => roles.get(p.key)?.kind === "joined") && (inline || isRemovalOnly(parts));
}

/** A ghost that inserts nothing visible, which must not wear the green "inserted" fill. */
function isRemovalOnly(parts: PreviewHunkPart[]): boolean {
  return parts.every((p) => !p.words && visibleBlocks(p.replacement).length === 0);
}

/**
 * Ghost DOM for the hunks sharing a region. The word and removal forms drop the
 * whole-block green fill: their del/ins spans or the struck text carry the change.
 * `roles` places each hunk's segment among its parts (only the last carries buttons); `inline`
 * means the change is drawn on the live text and the ghost carries only buttons.
 */
export function runGhost(
  parts: PreviewHunkPart[],
  ordinals: Map<HunkKey, number>,
  total: HunkTotals,
  pendingKeys: ReadonlySet<HunkKey>,
  view?: EditorView,
  pos?: number,
  tableCols?: number | null,
  roles: ReadonlyMap<HunkKey, PartRole> = new Map(),
  inline = false,
): HTMLElement {
  const colWidths = pos === undefined ? null : liveColumnWidths(view, pos);
  const wordForm = parts.length === 1 && !!parts[0]!.words;
  const wrap = document.createElement("div");
  wrap.className = inline
    ? "ai-preview-ghost ai-preview-ghost--inline"
    : wordForm
    ? "ai-preview-ghost ai-preview-ghost--words"
    : isRemovalOnly(parts)
      ? "ai-preview-ghost ai-preview-ghost--removal"
      : "ai-preview-ghost ai-preview-insert ai-preview-insert--block";
  if (parts.length > 1) wrap.classList.add("ai-preview-ghost--merged");
  wrap.setAttribute("contenteditable", "false");
  for (const part of parts) {
    wrap.appendChild(
      hunkPartDom(
        part,
        ordinals.get(part.key) ?? 0,
        total.get(part.key) ?? 0,
        pendingKeys.has(part.key),
        parts.length > 1,
        colWidths,
        roles.get(part.key) ?? SOLE,
        !inline,
      ),
    );
  }
  return tableCols ? rowGhostShell(wrap, tableCols) : wrap;
}
