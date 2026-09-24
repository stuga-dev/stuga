/**
 * Copy text, and say whether it worked. The Clipboard API exists only on a
 * secure origin, and a node on a LAN is usually plain http (livs-air.local),
 * so without it this falls back to the older selection copy, which browsers
 * still honour inside a click.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unfocused: the selection copy may still work.
    }
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off screen but focusable; a hidden element cannot hold a selection.
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  selectionHost().appendChild(area);
  const focused = document.activeElement as HTMLElement | null;
  try {
    area.focus();
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus?.();
  }
}

/** An open modal dialog makes everything outside it inert, so the textarea goes inside the dialog. */
function selectionHost(): HTMLElement {
  const holdingFocus = document.activeElement?.closest<HTMLElement>("dialog[open]");
  if (holdingFocus) return holdingFocus;
  const open = document.querySelectorAll<HTMLElement>("dialog[open]");
  return open[open.length - 1] ?? document.body;
}

/**
 * Give a plain-http origin a `navigator.clipboard.writeText`, so that copy
 * controls we do not own work there too. The Clipboard API is secure-origin
 * only, and a node on a LAN is usually plain http, where Astryx's own copy
 * buttons reach for `navigator.clipboard` and silently do nothing. The
 * selection copy browsers still honour inside a click stands in for it.
 *
 * Installed once at startup, before anything renders.
 */
export function installClipboardFallback(): void {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText === "function") return;
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(text: string): Promise<void> {
          // Rejecting like the real API keeps a caller's own failure path intact.
          if (!copyBySelection(text)) throw new Error("copy is not available on this page");
        },
      },
    });
  } catch {
    // A browser that refuses the definition keeps its own behaviour.
  }
}
