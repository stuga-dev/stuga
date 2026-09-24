/**
 * The document outline from its headings, highlighting the section being read.
 * The document scrolls inside `.doc-main`, which is therefore the observer's
 * root; a manual scroll of the outline briefly pauses auto-reveal.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Item } from "@astryxdesign/core/Item";
import { Text } from "@astryxdesign/core/Text";
import { useSharedEditor } from "../editor/editor-context";

interface Heading {
  level: number;
  text: string;
  pos: number;
}

/** How long a manual outline scroll suppresses auto-reveal. */
const MANUAL_SCROLL_QUIET_MS = 1200;

export function Outline({ width }: { width?: number }) {
  const { editor } = useSharedEditor();
  const [items, setItems] = useState<Heading[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const manualScrollUntil = useRef(0);

  useEffect(() => {
    if (!editor) return;
    const recompute = () => {
      const out: Heading[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading") {
          out.push({ level: node.attrs.level as number, text: node.textContent || "Untitled heading", pos });
        }
        return true;
      });
      setItems(out);
    };
    recompute();
    editor.on("transaction", recompute);
    return () => void editor.off("transaction", recompute);
  }, [editor]);

  useEffect(() => {
    if (!editor || items.length === 0) {
      setActivePos(null);
      return;
    }
    const scroller = editor.view.dom.closest(".doc-main");
    if (!(scroller instanceof HTMLElement)) return;

    // Through the view, not a query for h1–h3, so two headings with the same text stay distinct.
    const byEl = new Map<Element, number>();
    for (const it of items) {
      const dom = editor.view.nodeDOM(it.pos);
      if (dom instanceof HTMLElement) byEl.set(dom, it.pos);
    }
    if (byEl.size === 0) return;

    // The topmost heading in the band wins; a set rather than "last seen" keeps scrolling up correct.
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pos = byEl.get(e.target);
          if (pos === undefined) continue;
          if (e.isIntersecting) visible.add(pos);
          else visible.delete(pos);
        }
        if (visible.size > 0) {
          setActivePos(Math.min(...visible));
          return;
        }
        // Mid-section with no heading in the band: the last heading above it.
        const top = scroller.getBoundingClientRect().top;
        let best: number | null = null;
        for (const [el, pos] of byEl) {
          if (el.getBoundingClientRect().top <= top + 80) best = best === null ? pos : Math.max(best, pos);
        }
        setActivePos(best);
      },
      {
        root: scroller,
        // The reading band: from just below the toolbar to 30% down the view.
        rootMargin: "-8px 0px -70% 0px",
        threshold: 0,
      },
    );
    for (const el of byEl.keys()) observer.observe(el);
    return () => observer.disconnect();
  }, [editor, items]);

  // Keep the highlighted entry inside the outline's own viewport.
  useEffect(() => {
    if (activePos === null) return;
    if (Date.now() < manualScrollUntil.current) return;
    const panel = panelRef.current;
    const link = activeRef.current;
    if (!panel || !link) return;
    const p = panel.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    const margin = 32;
    if (l.top >= p.top + margin && l.bottom <= p.bottom - margin) return;
    panel.scrollTop += l.top - (p.top + p.height / 2);
  }, [activePos]);

  const onPanelScroll = useCallback(() => {
    manualScrollUntil.current = Date.now() + MANUAL_SCROLL_QUIET_MS;
  }, []);

  function goTo(pos: number) {
    if (!editor) return;
    // At once, rather than when the smooth scroll settles.
    setActivePos(pos);
    editor.chain().focus().setTextSelection(pos + 1).run();
    requestAnimationFrame(() => {
      const dom = editor.view.domAtPos(pos + 1);
      const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <aside
      className="outline-panel"
      ref={panelRef}
      onScroll={onPanelScroll}
      style={width ? { flexBasis: width } : undefined}
    >
      {/* Astryx Text is inline whatever its tag. */}
      <Text type="label" as="div" display="block">Outline</Text>
      {items.length === 0 ? (
        <Text type="supporting" color="secondary" as="p" display="block">
          No headings yet. Use H1–H3 to structure the doc.
        </Text>
      ) : (
        <nav className="outline-list">
          {items.map((it, i) => {
            const isActive = it.pos === activePos;
            return (
              <div
                key={i}
                ref={isActive ? activeRef : undefined}
                className={`outline-row${isActive ? " outline-row--active" : ""}`}
                style={{ paddingLeft: `${(it.level - 1) * 0.8}rem` }}
                aria-current={isActive ? "location" : undefined}
              >
                <Item as="div" density="compact" label={it.text} labelLines={1} onClick={() => goTo(it.pos)} />
              </div>
            );
          })}
        </nav>
      )}
    </aside>
  );
}
