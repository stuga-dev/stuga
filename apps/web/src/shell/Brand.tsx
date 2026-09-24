/** The brand slot's mark: Stuga's on every node, beside the node's name. Only the mark; each page supplies the wrapper. */
import { authConfig } from "../lib/session/auth-config";

/** The product's own name, which the brand slot shows until an administrator names the node. */
export const PRODUCT_NAME = "Stuga";

/** Stuga's mark, a roof over an S. Its own drawing sits low in a 0 0 100 100 box, so the box is recentred on it. */
const STUGA_MARK_PATH = "M 78 43 L 50 18 C 40 27, 28 36, 20 46 C 13 54, 18 64, 36 69 C 54 73, 64 73, 76 77 C 86 81, 84 92, 72 92 L 22 92";

export function Brand() {
  return (
    <span className="brand__mark">
      <svg viewBox="8 13 84 84" fill="none" className="brand__glyph" aria-hidden="true">
        <path d={STUGA_MARK_PATH} stroke="currentColor" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** What the brand slot, the tab and the sign-in pages call this node: the name set in Settings, else the product's. */
export function nodeName(): string {
  return authConfig().nodeName || PRODUCT_NAME;
}

/** What tells this node apart from others, in the switcher: its name, else its host. */
export function nodeLabel(): string {
  return authConfig().nodeLabel || nodeName();
}
