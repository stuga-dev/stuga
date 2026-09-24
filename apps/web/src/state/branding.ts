/**
 * The node's branding applied to the page: its name in the tab title, and its
 * colour as the `--brand` token. The brand colour is deliberately not the Astryx
 * accent (near-black, meaning "primary action"); it only marks the selected item.
 */
import { brandingConfig, setBrandingConfig, setNodeNameConfig, type BrandingConfig } from "../lib/session/auth-config";
import { createStore, useStore } from "../lib/store";
import { nodeName } from "../shell/Brand";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = clamp255(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = h / 360;
  return {
    r: clamp255(hue2rgb(p, q, hn + 1 / 3) * 255),
    g: clamp255(hue2rgb(p, q, hn) * 255),
    b: clamp255(hue2rgb(p, q, hn - 1 / 3) * 255),
  };
}

/* The marker is a 3px bar on a near-white fill in light mode and a dark fill in
 * dark mode, so lightness is clamped per mode to stay visible. Hue and saturation
 * are never changed. */
const LIGHT_MAX_L = 0.5;
const DARK_MIN_L = 0.6;

/** The brand hex as painted in one mode, or null for anything not `#rrggbb`. Shared with the settings preview. */
export function brandColor(hex: string, mode: "light" | "dark"): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const hsl = rgbToHsl(rgb);
  const l = mode === "light" ? Math.min(hsl.l, LIGHT_MAX_L) : Math.max(hsl.l, DARK_MIN_L);
  return toHex(hslToRgb({ ...hsl, l }));
}

const STYLE_TAG_ID = "stuga-branding-accent";

/**
 * Title the tab with the node's name and inject `--brand` for both modes, or
 * remove the override when no colour is set. `html:root` outranks the `:root`
 * default in styles/tokens.css regardless of stylesheet order.
 */
export function applyBranding(): void {
  document.title = nodeName();
  const { accentColor } = brandingConfig();
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;

  const light = accentColor ? brandColor(accentColor, "light") : null;
  const dark = accentColor ? brandColor(accentColor, "dark") : null;
  if (!light || !dark) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement("style");
    tag.id = STYLE_TAG_ID;
    document.head.appendChild(tag);
  }
  tag.textContent = `html:root { --brand: light-dark(${light}, ${dark}); }`;
}

const brandingVersion = createStore(0);

/** Install a new name or branding without a reload: the stylesheet, the title, and a re-render of the app. */
export function updateBranding(change: { node?: { name: string | null; label: string }; branding?: BrandingConfig }): void {
  if (change.node) setNodeNameConfig(change.node);
  if (change.branding) setBrandingConfig(change.branding);
  applyBranding();
  brandingVersion.update((n) => n + 1);
}

export function useBrandingVersion(): number {
  return useStore(brandingVersion);
}
