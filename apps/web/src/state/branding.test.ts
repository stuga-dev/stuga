// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { setAuthConfigForTest } from "../lib/session/auth-config";
import { applyBranding, brandColor, updateBranding } from "./branding";

/** HSL lightness, the axis the clamps work on. */
function lightness(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)!;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i]!, 16) / 255) as [number, number, number];
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

/** Hue in degrees, to check the brand's identity survives the clamp. */
function hue(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)!;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i]!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h * 60;
}

// The clamps work in HSL and come back through 8-bit channels, so a value
// pinned to a bound can land a rounding step the other side of it.
const ROUNDING = 1 / 255;

describe("brandColor", () => {
  it("rejects anything that is not #rrggbb", () => {
    for (const bad of ["", "red", "#fff", "#12345", "#gggggg", "rgb(0,0,0)"]) {
      expect(brandColor(bad, "light")).toBeNull();
      expect(brandColor(bad, "dark")).toBeNull();
    }
    expect(brandColor("#7c3aed", "light")).not.toBeNull();
  });

  it("darkens a pale brand for light mode so a 3px bar still reads on a light fill", () => {
    const pale = brandColor("#e0ccff", "light")!;
    expect(lightness(pale)).toBeLessThanOrEqual(0.5 + ROUNDING);
    expect(lightness(pale)).toBeLessThan(lightness("#e0ccff"));
  });

  it("lightens a deep brand for dark mode so the bar reads on a dark fill", () => {
    const deep = brandColor("#0a0a23", "dark")!;
    expect(lightness(deep)).toBeGreaterThanOrEqual(0.6 - ROUNDING);
    expect(lightness(deep)).toBeGreaterThan(lightness("#0a0a23"));
  });

  it("keeps the hue: the clamp moves lightness only", () => {
    for (const hex of ["#e0ccff", "#0a0a23", "#f59e0b", "#0ea5e9"]) {
      for (const mode of ["light", "dark"] as const) {
        expect(Math.abs(hue(brandColor(hex, mode)!) - hue(hex))).toBeLessThan(2);
      }
    }
  });

  it("leaves a colour alone when it is already inside the band for that mode", () => {
    // Lightness 0.5 sits on the light bound, so light mode keeps it verbatim.
    expect(lightness("#8000ff")).toBeCloseTo(0.5, 2);
    expect(brandColor("#8000ff", "light")).toBe("#8000ff");
    // Lightness 0.66 is above the dark bound, so dark mode keeps it verbatim.
    expect(lightness("#f59e50")).toBeGreaterThan(0.6);
    expect(brandColor("#f59e50", "dark")).toBe("#f59e50");
  });
});

describe("applyBranding", () => {
  afterEach(() => {
    setAuthConfigForTest(null);
    document.getElementById("stuga-branding-accent")?.remove();
    document.title = "";
  });

  it("titles the tab with the node's name, or the product's until it has one: never its host", () => {
    setAuthConfigForTest(null);
    applyBranding();
    expect(document.title).toBe("Stuga");

    setAuthConfigForTest({ nodeName: null, nodeLabel: "livs-air" });
    applyBranding();
    expect(document.title).toBe("Stuga");

    setAuthConfigForTest({ nodeName: "Acme Docs", nodeLabel: "Acme Docs" });
    applyBranding();
    expect(document.title).toBe("Acme Docs");
  });

  it("applies a rename or saved branding live: the title and the brand colour change without a reload", () => {
    setAuthConfigForTest(null);
    applyBranding();
    expect(document.getElementById("stuga-branding-accent")).toBeNull();

    updateBranding({ node: { name: "Acme Docs", label: "Acme Docs" }, branding: { accentColor: "#7c3aed" } });
    expect(document.title).toBe("Acme Docs");
    expect(document.getElementById("stuga-branding-accent")?.textContent).toContain("--brand: light-dark(");

    // The name removed: the tab goes back to the product's name, not to the host the label falls back to.
    updateBranding({ node: { name: null, label: "livs-air" }, branding: { accentColor: null } });
    expect(document.title).toBe("Stuga");
    expect(document.getElementById("stuga-branding-accent")).toBeNull();
  });
});
