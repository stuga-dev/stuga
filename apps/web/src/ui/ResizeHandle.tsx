/**
 * A draggable divider that resizes the panel beside it, and the stored width it drives.
 * `dir` is +1 for a panel on the left of the handle and -1 for one on its right.
 */
import { useCallback, useRef, useState } from "react";
import { readStoredInt, writeStored } from "../lib/storage";

export function usePanelWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): [number, (next: number) => void] {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const [width, setWidth] = useState<number>(() => readStoredInt("local", key, { min, max, fallback }));
  const set = useCallback(
    (next: number) => {
      const c = clamp(next);
      setWidth(c);
      writeStored("local", key, String(c));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, min, max],
  );
  return [width, set];
}

interface ResizeHandleProps {
  width: number;
  onResize: (next: number) => void;
  dir: 1 | -1;
  label: string;
}

export function ResizeHandle({ width, onResize, dir, label }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    start.current = { x: e.clientX, w: width };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    onResize(start.current.w + dir * (e.clientX - start.current.x));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  return (
    <div
      className={`resize-handle${dragging ? " resize-handle--dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
