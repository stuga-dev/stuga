/**
 * Interface text belongs in the catalog. This finds English written straight into the app: JSX
 * text, text-bearing props and object fields, toasts and announcements, and text set on DOM
 * nodes. Findings already in literals-baseline.json are tolerated until extracted; a new one
 * fails. `UPDATE_LITERALS_BASELINE=1` rewrites the baseline after extraction removes entries.
 * A line that must stay English (a stored default, a name) carries an `i18n-exempt` comment.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, Visitor } from "vite";
import { expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(here, "..");
const baselinePath = join(here, "literals-baseline.json");

/** Props and fields whose string is something a person reads. */
const TEXT_KEYS = new Set([
  "label", "title", "description", "aria-label", "aria-description", "aria-valuetext", "alt", "placeholder",
  "tooltip", "body", "heading", "subheading", "message", "hint", "note", "caption", "subtitle", "detail",
  "actionLabel", "submitLabel", "confirmLabel", "cancelLabel", "dismissLabel", "removeLabel", "removedNote",
  "searchPlaceholder", "emptySearchResultsText", "emptyText", "emptyLabel", "disabledMessage", "unchangedText",
  "helperText", "errorMessage", "summary", "text", "prompt", "trigger", "name", "defaultName", "about", "signIn",
]);
/** Props that are never text, whatever their value looks like. */
const NON_TEXT_PROPS = new Set([
  "className", "href", "to", "src", "type", "variant", "size", "id", "role", "key", "rel", "target", "method",
  "autoComplete", "inputMode", "lang", "dir", "spellCheck", "accept", "pattern", "form", "htmlFor", "icon",
  "data-testid", "aria-keyshortcuts", "aria-controls", "aria-labelledby", "aria-describedby", "host",
]);
/** Calls whose string argument is shown to a person. */
const TEXT_CALLS = /^(announce|setError|setMessage|setNotice|setStatus|setHint|setNote|setProblem|setWarning|setFailure|setLabel)$/;
const DOM_TEXT_FIELDS = new Set(["textContent", "innerText", "title", "placeholder"]);
const DOM_TEXT_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt"]);

/** A value that reads as words, not a token such as "primary" or "sm". */
function isProse(text: string): boolean {
  const s = text.trim();
  if (!/\p{L}/u.test(s)) return false;
  if (/^(https?:|mailto:|\/|\.|#|var\(|--)/.test(s)) return false;
  return /[A-Z]/.test(s) || /\p{L}\s+\p{L}/u.test(s) || /[^\p{ASCII}]/u.test(s);
}

interface Node {
  type: string;
  start: number;
  [key: string]: unknown;
}

/** The strings an expression can evaluate to, through conditionals, `??` and `||`. */
function textsOf(node: Node | null | undefined, out: { text: string; at: number }[] = []): { text: string; at: number }[] {
  if (!node) return out;
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string") out.push({ text: node.value, at: node.start });
      break;
    case "TemplateLiteral": {
      const quasis = node.quasis as { value: { cooked: string | null } }[];
      const text = quasis.map((q) => q.value.cooked ?? "").join("…");
      if (/\p{L}{2,}/u.test(text)) out.push({ text, at: node.start });
      break;
    }
    case "ConditionalExpression":
      textsOf(node.consequent as Node, out);
      textsOf(node.alternate as Node, out);
      break;
    case "LogicalExpression":
      textsOf(node.left as Node, out);
      textsOf(node.right as Node, out);
      break;
    case "JSXExpressionContainer":
    case "ParenthesizedExpression":
    case "TSAsExpression":
      textsOf(node.expression as Node, out);
      break;
  }
  return out;
}

function propName(node: Node): string | null {
  const key = node.key as Node | undefined;
  if (!key) return null;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

function scan(file: string, source: string): string[] {
  const lang = file.endsWith(".tsx") ? "tsx" : "ts";
  const { program, errors } = parseSync(file, source, { lang });
  if (errors.length) throw new Error(`${file}: ${errors[0]?.message}`);
  const lines = source.split("\n");
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (at: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const exempt = (at: number) => {
    const line = lineOf(at);
    return /i18n-exempt/.test(lines[line] ?? "") || /i18n-exempt/.test(lines[line - 1] ?? "");
  };
  const found: string[] = [];
  const add = (text: string, at: number, prose = isProse(text)) => {
    if (prose && !exempt(at)) found.push(text.replace(/\s+/g, " ").trim());
  };
  const visitors: Record<string, (node: Node) => void> = {
    JSXText(node: Node) {
      const text = String(node.value);
      add(text, node.start, /\p{L}/u.test(text));
    },
    JSXElement(node: Node) {
      for (const child of node.children as Node[]) {
        if (child.type === "JSXExpressionContainer") for (const s of textsOf(child)) add(s.text, s.at);
      }
    },
    JSXAttribute(node: Node) {
      const name = node.name as Node;
      const attr = name.type === "JSXIdentifier" ? String(name.name) : null;
      if (!attr || NON_TEXT_PROPS.has(attr) || attr.startsWith("on") || attr.startsWith("data-")) return;
      for (const s of textsOf(node.value as Node)) add(s.text, s.at);
    },
    Property(node: Node) {
      const name = propName(node);
      if (name && TEXT_KEYS.has(name)) for (const s of textsOf(node.value as Node)) add(s.text, s.at);
    },
    CallExpression(node: Node) {
      const callee = node.callee as Node;
      const name = callee.type === "Identifier" ? String(callee.name) : callee.type === "MemberExpression" ? String((callee.property as Node).name) : "";
      const args = node.arguments as Node[];
      if (TEXT_CALLS.test(name)) for (const s of textsOf(args[0])) add(s.text, s.at);
      if (name === "setAttribute" && args[0]?.type === "Literal" && DOM_TEXT_ATTRIBUTES.has(String(args[0].value))) {
        for (const s of textsOf(args[1])) add(s.text, s.at);
      }
    },
    AssignmentExpression(node: Node) {
      const left = node.left as Node;
      if (left.type === "MemberExpression" && DOM_TEXT_FIELDS.has(String((left.property as Node).name))) {
        for (const s of textsOf(node.right as Node)) add(s.text, s.at);
      }
    },
  };
  new Visitor(visitors as never).visit(program as never);
  return found;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "i18n" && entry.name !== "test") sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function findings(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of sourceFiles(srcDir).sort()) {
    const found = scan(file, readFileSync(file, "utf8"));
    if (found.length) out[relative(srcDir, file)] = found;
  }
  return out;
}

it("adds no English outside the catalog", () => {
  const now = findings();
  // `LITERALS_REPORT=src/editor`: every finding under that path, tolerated or not, to extract.
  const report = process.env.LITERALS_REPORT;
  if (report) {
    const prefix = relative(srcDir, join(srcDir, "..", report));
    const under = Object.entries(now).filter(([file]) => file === prefix || file.startsWith(`${prefix}/`));
    expect(Object.fromEntries(under)).toEqual({});
    return;
  }
  if (process.env.UPDATE_LITERALS_BASELINE) {
    writeFileSync(baselinePath, JSON.stringify(now, null, 2) + "\n");
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, string[]>;
  const added: string[] = [];
  for (const [file, texts] of Object.entries(now)) {
    // A multiset, so a second copy of a tolerated string is still new.
    const left = [...(baseline[file] ?? [])];
    for (const text of texts) {
      const i = left.indexOf(text);
      if (i >= 0) left.splice(i, 1);
      else added.push(`${file}: ${text}`);
    }
  }
  expect(added, "put these in src/i18n/messages/en and call t(), or mark a line that must stay English with an i18n-exempt comment").toEqual([]);
});

it("finds the shapes interface text takes", () => {
  const found = scan(
    "probe.tsx",
    `const a = <Button label="Save it" variant="primary">Hello {x ? "Yes" : "No"} {t("common.ok")}</Button>;
     el.textContent = \`Hi \${n} there\`;
     toast({ body: "Done.", type: "info" });
     node.setAttribute("aria-label", "Close panel");
     announce(\`\${n} documents found\`);
     const b = { label: "Untitled" }; // i18n-exempt: stored
     const c = <Icon className="Big Thing" />;`,
  );
  expect(found.sort()).toEqual(["Close panel", "Done.", "Hello", "Hi … there", "No", "Save it", "Yes", "… documents found"]);
});

/** Every relative module main.tsx loads before the catalog, through static imports only. */
function bootModules(): string[] {
  const seen = new Set<string>();
  const resolve = (from: string, spec: string): string | null => {
    const base = join(from, "..", spec);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      try {
        if (readFileSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
      } catch {
        // try the next spelling
      }
    }
    return null;
  };
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const { program } = parseSync(file, readFileSync(file, "utf8"), { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
    for (const statement of (program as unknown as { body: Node[] }).body) {
      const source = statement.source as Node | undefined;
      const typeOnly = statement.importKind === "type" || statement.exportKind === "type";
      if (!source || typeOnly || typeof source.value !== "string" || !source.value.startsWith(".")) continue;
      const target = resolve(file, source.value);
      if (target) visit(target);
    }
  };
  visit(join(srcDir, "main.tsx"));
  return [...seen];
}

/** Calls to t() that run when the module is imported rather than when something renders. */
function moduleScopeTranslations(file: string): number {
  const { program } = parseSync(file, readFileSync(file, "utf8"), { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  let count = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    if (/Function|Method|ClassBody/.test(node.type)) return;
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      if (callee.type === "Identifier" && /^(t|tDynamic|tRich)$/.test(String(callee.name))) count++;
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent") walk(child);
  };
  walk((program as unknown as { body: Node[] }).body);
  return count;
}

it("translates nothing at import in a module loaded before the catalog", () => {
  const early = bootModules().filter((file) => moduleScopeTranslations(file) > 0).map((file) => relative(srcDir, file));
  expect(early).toEqual([]);
});
