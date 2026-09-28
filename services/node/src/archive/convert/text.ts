/**
 * Line-level rewrites of another app's Markdown before Stuga parses it: its own syntax spelled
 * as CommonMark, never inside code.
 */

/** Lines of a fenced code block's opening: up to 3 spaces, then 3 or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * `markdown` with each line outside fenced code passed through `line`, in order; null drops the
 * line. A fence's own lines and what it holds are kept as they are.
 */
export function mapProse(markdown: string, line: (text: string) => string | null): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const text of markdown.split("\n")) {
    if (fence !== null) {
      out.push(text);
      const close = FENCE.exec(text);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && text.trim() === close[0].trim()) fence = null;
      continue;
    }
    const open = FENCE.exec(text);
    // A backtick fence's info string holds no backtick.
    if (open && !(open[1]![0] === "`" && text.slice(open[0].length).includes("`"))) {
      fence = open[1]!;
      out.push(text);
      continue;
    }
    const kept = line(text);
    if (kept !== null) out.push(kept);
  }
  return out.join("\n");
}

/** `text` with each stretch outside a code span passed through `rewrite`; a span's backticks and what they hold are kept. */
export function mapOutsideCodeSpans(text: string, rewrite: (part: string) => string): string {
  let out = "";
  let from = 0;
  const runs = /`+/g;
  for (let open = runs.exec(text); open; open = runs.exec(text)) {
    const tick = open[0];
    let close: RegExpExecArray | null;
    do close = runs.exec(text);
    while (close && close[0].length !== tick.length);
    if (!close) {
      // An unmatched run is literal; the next run may still open a span.
      runs.lastIndex = open.index + tick.length;
      continue;
    }
    out += rewrite(text.slice(from, open.index)) + text.slice(open.index, close.index + tick.length);
    from = close.index + tick.length;
  }
  return out + rewrite(text.slice(from));
}

/** A list item's task box, which Stuga has no node for, as a character that reads the same: `- [x] Done` → `- ☑ Done`. */
const TASK = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+/;

export function taskBox(line: string): string {
  return line.replace(TASK, (_, lead: string, mark: string) => `${lead}${mark === " " ? "☐" : "☑"} `);
}

/** `text` as Markdown that reads as that text: every character CommonMark could take as syntax escaped. */
export function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>#!|~]/g, "\\$&");
}

/** A heading line that shows `title`. */
export const headingLine = (title: string): string => `# ${escapeText(title.replace(/\s+/g, " ").trim())}`;
