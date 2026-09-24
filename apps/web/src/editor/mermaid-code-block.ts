/**
 * Renders `codeBlock{language:"mermaid"}` as a diagram. The NodeView is not
 * part of getSchema(), so the schema stays identical to the server's, and
 * mermaid loads lazily in its own chunk. Other languages render as plain code.
 */
import CodeBlock from "@tiptap/extension-code-block";
import type { NodeViewRendererProps } from "@tiptap/react";
import type { NodeView } from "@tiptap/pm/view";

let mermaidModule: Promise<typeof import("mermaid")["default"]> | null = null;
function getMermaid() {
  mermaidModule ??= import("mermaid").then((m) => m.default);
  return mermaidModule;
}

/** The active theme, published as `data-theme` on <html>. */
function isDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

/**
 * Themed from our tokens, read here because mermaid lays the SVG out in a
 * detached subtree where `var()` resolves to nothing.
 */
function themeVariables(): Record<string, string | boolean> {
  const dark = isDark();
  const rootStyle = getComputedStyle(document.documentElement);
  const token = (name: string) => rootStyle.getPropertyValue(name).trim();

  const fg = token("--color-text-primary");
  return {
    darkMode: dark,
    background: token("--color-background-surface"),
    primaryColor: token("--color-accent-muted"),
    primaryBorderColor: token("--color-accent"),
    primaryTextColor: fg,
    textColor: fg,
    lineColor: token("--color-text-secondary"),
    fontSize: "14px",
  };
}

/**
 * `suppressErrorRendering` must stay true: without it a syntax error renders
 * mermaid's own error graphic instead of throwing, and leaves a node in <body>.
 * `look: "classic"` keeps borders the themed flat colour rather than gradients.
 * `layout: "dagre"` must stay: mermaid 12 defaults to ELK, which the build replaces with
 * elk-unavailable.ts, so without it every flowchart, state, class and ER diagram fails.
 */
const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: "base",
  look: "classic",
  layout: "dagre",
  suppressErrorRendering: true,
  securityLevel: "strict",
  flowchart: { htmlLabels: true, curve: "basis" },
} as const;

let idCounter = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

/**
 * The diagram, with the editable source (the contentDOM, so the text stays in
 * the CRDT) shown above a live preview while the caret is inside the block.
 */
function mermaidNodeView(props: NodeViewRendererProps): NodeView {
  const { node, editor, getPos } = props;

  const wrap = el("div", "mermaid-wrap");
  wrap.dataset.nodeViewWrapper = "";

  const sourceEl = el("pre", "mermaid-source");
  const code = document.createElement("code");
  sourceEl.append(code);

  // ProseMirror marks a NodeView non-editable only when it has no contentDOM, so the preview says so itself.
  // The attribute, not the IDL property, which jsdom lacks.
  const preview = el("div", "mermaid-preview");
  preview.setAttribute("contenteditable", "false");
  preview.title = editor.isEditable ? "Double-click to edit" : "";

  wrap.append(sourceEl, preview);

  let editing = false;
  const applyMode = () => {
    sourceEl.style.display = editing ? "block" : "none";
    wrap.classList.toggle("mermaid-wrap--editing", editing);
  };

  const getPosSafe = () => (typeof getPos === "function" ? getPos() : undefined);
  const liveNode = () => {
    const pos = getPosSafe();
    return pos != null ? editor.state.doc.nodeAt(pos) : null;
  };
  // Requires focus, so a freshly loaded document does not open a block's source.
  const caretInside = (): boolean => {
    if (!editor.isEditable || !editor.view.hasFocus()) return false;
    const pos = getPosSafe();
    if (pos == null) return false;
    const cur = editor.state.doc.nodeAt(pos);
    if (!cur || cur.type.name !== "codeBlock") return false;
    const { from, to } = editor.state.selection;
    return from > pos && to <= pos + cur.nodeSize;
  };

  let lastSource = "";
  let lastDark = isDark();
  let renderSeq = 0;

  async function render(source: string) {
    const trimmed = source.trim();
    lastSource = source;
    lastDark = isDark();
    if (!trimmed) {
      preview.innerHTML = editing ? `<span class="mermaid-hint">Mermaid diagram — type below…</span>` : "";
      return;
    }
    // Debounced renders can overlap.
    const seq = ++renderSeq;
    try {
      const mermaid = await getMermaid();
      // Per render, since the theme may have flipped.
      mermaid.initialize({ ...MERMAID_CONFIG, themeVariables: themeVariables() });
      const { svg } = await mermaid.render(`stuga-mermaid-${++idCounter}`, trimmed);
      if (seq !== renderSeq) return;
      preview.innerHTML = svg;
      // Mermaid pins width="100%"; without it the viewBox sets the size and CSS caps it.
      preview.querySelector("svg")?.removeAttribute("width");
    } catch {
      if (seq !== renderSeq) return;
      preview.innerHTML = `<span class="mermaid-error">Invalid Mermaid syntax</span>`;
    }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRender = (source: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      render(source);
    }, 250);
  };

  // A block inserted from the slash menu starts with the caret inside.
  editing = caretInside();
  applyMode();
  render(node.textContent);

  preview.addEventListener("dblclick", () => {
    if (!editor.isEditable) return;
    const pos = getPosSafe();
    if (pos != null) editor.commands.setTextSelection(pos + 1);
    editor.view.focus();
  });

  const onSelectionUpdate = () => {
    const inside = caretInside();
    if (inside === editing) return;
    editing = inside;
    applyMode();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    render(liveNode()?.textContent ?? node.textContent);
  };
  editor.on("selectionUpdate", onSelectionUpdate);
  editor.on("blur", onSelectionUpdate);

  const themeObserver = new MutationObserver(() => {
    if (isDark() !== lastDark) render(lastSource);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    dom: wrap,
    contentDOM: code,
    // The SVG is not document content; only the <code> is read back.
    ignoreMutation: (m) => !code.contains(m.target),
    update(updated: typeof node) {
      if (updated.type.name !== "codeBlock") return false;
      // Recreated as a plain code block.
      if (updated.attrs.language !== "mermaid") return false;
      // Debounced while typing; at once for a remote change.
      if (editing) scheduleRender(updated.textContent);
      else render(updated.textContent);
      return true;
    },
    deselectNode() {
      onSelectionUpdate();
    },
    destroy() {
      editor.off("selectionUpdate", onSelectionUpdate);
      editor.off("blur", onSelectionUpdate);
      if (debounceTimer) clearTimeout(debounceTimer);
      themeObserver.disconnect();
    },
  };
}

/** StarterKit's CodeBlock with the mermaid view; use with `StarterKit.configure({ codeBlock: false })`. */
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    // Undefined falls back to the default rendering, a case NodeViewRenderer does not model.
    return ((props: NodeViewRendererProps) =>
      props.node.attrs.language === "mermaid" ? mermaidNodeView(props) : undefined) as never;
  },
});
