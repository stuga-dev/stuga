import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// vitest stubs CSS imports, and cwd is the package root.
const SRC = resolve(process.cwd(), "src");
const DIR = resolve(SRC, "styles");
const SHEETS = readdirSync(DIR).filter((f) => f.endsWith(".css"));

/** The stylesheets a module imports directly, as source text. */
function stylesheetsOf(module: string): string[] {
  const file = resolve(SRC, module);
  return [...readFileSync(file, "utf8").matchAll(/^import "(\.[^"]+\.css)";$/gm)].map((m) =>
    readFileSync(resolve(dirname(file), m[1]!), "utf8"),
  );
}

describe("stylesheets", () => {
  it.each(SHEETS)("take colours from theme tokens, never literals: %s", (sheet) => {
    const css = readFileSync(resolve(DIR, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const literals = css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/gi) ?? [];
    expect(literals).toEqual([]);
  });

  // Both pages are lazy chunks; only main.tsx and App.tsx load CSS for every page.
  it.each(["pages/AskPage.tsx", "pages/ItemPage.tsx"])("style image captions on every page that renders markdown: %s", (page) => {
    const css = [...stylesheetsOf("main.tsx"), ...stylesheetsOf("App.tsx"), ...stylesheetsOf(page)].join("\n");
    expect(css).toContain(".stuga-image-figure {");
    expect(css).toContain(".stuga-image-caption {");
  });
});
