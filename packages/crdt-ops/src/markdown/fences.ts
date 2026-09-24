/**
 * CommonMark fenced-code-block detection for line scanners that must leave code
 * alone: an opener is 3+ backticks or tildes indented 0-3 columns past its
 * container, and only a run of the same character at least as long closes it.
 */

export interface Fence {
  char: "`" | "~";
  length: number;
  /** Indent of the container the fence sits in; the 0-3 column allowance is measured from here. */
  base: number;
}

function leading(line: string): { width: number; rest: string } {
  const ws = /^[ \t]*/.exec(line)![0];
  return { width: ws.replace(/\t/g, "    ").length, rest: line.slice(ws.length) };
}

/** The fence `line` opens inside a container indented `base` columns, or null. */
export function fenceOpener(line: string, base = 0): Fence | null {
  const { width, rest } = leading(line);
  if (width - base < 0 || width - base > 3) return null;
  const m = /^(`{3,}|~{3,})(.*)$/.exec(rest);
  if (!m) return null;
  const char = m[1]![0] as "`" | "~";
  if (char === "`" && m[2]!.includes("`")) return null;
  return { char, length: m[1]!.length, base };
}

/** Whether `line` closes `fence`. */
export function closesFence(line: string, fence: Fence): boolean {
  const { width, rest } = leading(line);
  if (width - fence.base < 0 || width - fence.base > 3) return false;
  const m = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
  return m !== null && m[1]![0] === fence.char && m[1]!.length >= fence.length;
}

/** Per line, whether it belongs to a top-level fenced code block (delimiters included). An unclosed fence runs to the end. */
export function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let fence: Fence | null = null;
  for (const line of lines) {
    if (fence) {
      out.push(true);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = fenceOpener(line);
    out.push(fence !== null);
  }
  return out;
}

/** Whether `text` opens a fenced code block it never closes. */
export function leavesFenceOpen(text: string): boolean {
  let fence: Fence | null = null;
  for (const line of text.split("\n")) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else {
      fence = fenceOpener(line);
    }
  }
  return fence !== null;
}
