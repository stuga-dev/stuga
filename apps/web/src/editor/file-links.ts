/**
 * Links to a file attached to a document, shown as a chip: the link itself is styled in
 * editor.css, and this extension adds the file's size after its name once a HEAD request has
 * told it. Decorations only; the document holds a plain link, as the server and Markdown do.
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Mark } from "@tiptap/pm/model";
import { MEDIA_GET_PATH } from "@stuga/protocol/api/media";
import { byteSize } from "../lib/format";

/** The name of the attached file a link points at, or null for any other link. */
export function attachedFileName(href: string): string | null {
  const name = MEDIA_GET_PATH.exec(href)?.[2];
  if (!name) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The id of the Stuga page an in-app link opens, or null. */
export function linkedDocId(href: string): string | null {
  return /^\/doc\/([^/?#\s]+)/.exec(href)?.[1] ?? null;
}

/** Bytes per file link, shared by every editor: undefined not asked yet, null asked and unknown. */
const sizes = new Map<string, number | null>();

const key = new PluginKey<DecorationSet>("fileChips"); // i18n-exempt: plugin identifier

/** Each run of text carrying one file link, with where it ends. */
function fileLinks(state: EditorState): Array<{ href: string; to: number; mark: Mark }> {
  const link = state.schema.marks.link;
  const out: Array<{ href: string; to: number; mark: Mark }> = [];
  if (!link) return out;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = link.isInSet(node.marks);
    const href = mark ? String(mark.attrs.href ?? "") : "";
    if (!mark || !attachedFileName(href)) return;
    const last = out[out.length - 1];
    // The same link continued in the next text node (a bold word inside it) extends the run.
    if (last && last.to === pos && last.href === href) last.to = pos + node.nodeSize;
    else out.push({ href, to: pos + node.nodeSize, mark });
  });
  return out;
}

function decorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  for (const { href, to, mark } of fileLinks(state)) {
    const size = sizes.get(href);
    if (typeof size !== "number") continue;
    decos.push(
      Decoration.widget(
        to,
        () => {
          const span = document.createElement("span");
          span.className = "file-chip__size";
          span.textContent = byteSize(size);
          return span;
        },
        { side: -1, marks: [mark], key: `${href}#${size}`, ignoreSelection: true },
      ),
    );
  }
  return DecorationSet.create(state.doc, decos);
}

export const FileChips = Extension.create({
  name: "fileChips", // i18n-exempt: extension identifier

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorations(state),
          apply: (tr, old, _before, state) => (tr.docChanged || tr.getMeta(key) ? decorations(state) : old.map(tr.mapping, tr.doc)),
        },
        props: { decorations: (state) => key.getState(state) },
        view: (view) => {
          let alive = true;
          const ask = () => {
            for (const { href } of fileLinks(view.state)) {
              if (sizes.has(href)) continue;
              sizes.set(href, null);
              fetch(href, { method: "HEAD", credentials: "same-origin" })
                .then((res) => {
                  const length = Number(res.headers.get("content-length"));
                  if (!res.ok || !Number.isFinite(length) || length <= 0) return;
                  sizes.set(href, length);
                  if (alive && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true).setMeta("addToHistory", false));
                })
                .catch(() => {});
            }
          };
          ask();
          return {
            update: (_view, prev) => {
              if (!prev.doc.eq(view.state.doc)) ask();
            },
            destroy: () => {
              alive = false;
            },
          };
        },
      }),
    ];
  },
});
