/**
 * The `append` edit: add text at the end of a document, or at the end of one
 * heading's section, and touch nothing else. Pure over markdown, so the ledger
 * validates it against its working copy like `str_replace`.
 */
import { fencedLines, leavesFenceOpen } from "@stuga/crdt-ops";

interface HeadingLine {
  index: number;
  level: number;
  title: string;
}

/** Collapse whitespace and case, and drop any leading `#`s, so "## Log" and
 *  "log" name the same heading. */
function normalizeHeading(s: string): string {
  return s.replace(/^#+\s*/, "").replace(/\s+#*\s*$/, "").trim().replace(/\s+/g, " ").toLowerCase();
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** Every ATX heading outside fenced code. The serializer never writes setext headings. */
function headingsOf(lines: string[]): HeadingLine[] {
  const out: HeadingLine[] = [];
  const fenced = fencedLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = HEADING_RE.exec(lines[i]!);
    if (m) out.push({ index: i, level: m[1]!.length, title: m[2]! });
  }
  return out;
}

export type AppendResult =
  | { markdown: string }
  | { error: "heading_not_found" | "heading_ambiguous" | "unbalanced_fence"; count?: number };

const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * The separator between what is there and what is added: a blank line, so the
 * addition is its own block — except between two list items, where a blank
 * line would turn a tight list loose (or split it in two), and an agent
 * appending "- next item" to a list means the same list.
 */
function glue(lastLine: string | undefined, firstAdded: string): string[] {
  if (lastLine !== undefined && LIST_LINE_RE.test(lastLine) && LIST_LINE_RE.test(firstAdded)) return [];
  return [""];
}

/**
 * Append `text` to `current`. With no heading, it goes after the last
 * non-blank line of the document. With one, it goes at the end of that
 * heading's section — before the next heading of the same or a higher level,
 * or the end of the document. The heading must match exactly one heading
 * (case- and whitespace-insensitive, `#`s optional); zero or several is an
 * error the caller reports back to the agent, never a guess.
 */
export function appendMarkdown(current: string, text: string, heading?: string | null): AppendResult {
  // trimEnd, not /\s+$/, which is quadratic on agent text ending in a non-space.
  const addition = text.trimEnd();
  if (addition === "") return { markdown: current };
  // An unclosed fence would turn everything below the section into code; refuse rather than guess a close.
  if (leavesFenceOpen(addition)) return { error: "unbalanced_fence" };
  const lines = current.split("\n");
  if (!heading || heading.trim() === "") {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    const added = addition.split("\n");
    const body = lines.length === 0 ? added : [...lines, ...glue(lines[lines.length - 1], added[0]!), ...added];
    return { markdown: `${body.join("\n")}\n` };
  }
  const wanted = normalizeHeading(heading);
  const headings = headingsOf(lines);
  const matches = headings.filter((h) => normalizeHeading(h.title) === wanted);
  if (matches.length === 0) return { error: "heading_not_found" };
  if (matches.length > 1) return { error: "heading_ambiguous", count: matches.length };
  const target = matches[0]!;
  const next = headings.find((h) => h.index > target.index && h.level <= target.level);
  const end = next ? next.index : lines.length;
  const before = lines.slice(0, target.index + 1);
  const section = lines.slice(target.index + 1, end);
  const after = lines.slice(end);
  while (section.length > 0 && section[section.length - 1]!.trim() === "") section.pop();
  const added = addition.split("\n");
  const rebuilt = [...before, ...section, ...glue(section[section.length - 1], added[0]!), ...added];
  if (after.length > 0) rebuilt.push("", ...after);
  let markdown = rebuilt.join("\n");
  if (!markdown.endsWith("\n")) markdown += "\n";
  return { markdown };
}
