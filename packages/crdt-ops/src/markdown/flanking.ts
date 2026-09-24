/**
 * Whitespace at emphasis-mark edges, which CommonMark's flanking rules would
 * otherwise eat or turn into literal delimiters.
 *
 * The repair is a numeric character reference (`&#32;`): not whitespace to the
 * delimiter scanner, the original character after inline parsing. It holds at a
 * line edge, and mid-line when the character on the other side of the delimiter
 * run is punctuation or whitespace — which the serializer can supply by also
 * respelling a neighbouring text character (`**x&#32;**&#121;`). Only whitespace
 * between two fusing delimiter runs has no spelling; `expelMarkEdgeWhitespace`
 * moves exactly that residue out of the mark.
 */
import { Fragment } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";

/** Spell every non-newline whitespace character as a numeric character reference. */
export function wsEntities(s: string): string {
  return s.replace(/[^\S\n]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Marks whose delimiters obey the flanking rules (`code` pads itself; link/underline have none). */
const FLANKED_MARKS = new Set(["bold", "italic", "strike"]);

/** The first / last character each mark's delimiter writes at an inline boundary.
 *  Mirrors the serializer's mark table; `underline` writes nothing. */
const MARK_OPEN_CHAR: Record<string, string> = { bold: "*", italic: "*", strike: "~", code: "`", link: "[" };
const MARK_CLOSE_CHAR: Record<string, string> = { bold: "*", italic: "*", strike: "~", code: "`", link: ")" };

/** ASCII punctuation or whitespace. ASCII-only on purpose: a wrong "safe" verdict
 *  prints literal `**`, a wrong "unsafe" one only expels a space. */
function flankSafeChar(ch: string): boolean {
  return /[\s!-/:-@[-`{-~]/.test(ch);
}

/** What the serializer writes just outside a mark's delimiters, and whether it is
 *  the neighbour's own text (respellable) rather than a fixed delimiter. */
interface InlineBoundary {
  ch: string;
  text: boolean;
}

/** The boundary immediately after the delimiters that close on `node`, or null at a line end. */
function boundaryAfter(node: PMNode, next: PMNode | null): InlineBoundary | null {
  if (!next || next.type.name === "hardBreak") return null;
  // Marks open in schema rank order, so the first non-shared one writes first.
  for (const m of next.marks) {
    if (m.isInSet(node.marks)) continue;
    const d = MARK_OPEN_CHAR[m.type.name];
    if (d) return { ch: d, text: false };
  }
  const t = next.isText ? (next.text ?? "") : "";
  if (t) return { ch: t[0]!, text: true };
  if (next.type.name === "footnoteReference") return { ch: "[", text: false };
  return null;
}

/** The boundary immediately before the delimiters that open on `node`, or null at a line start. */
function boundaryBefore(node: PMNode, prev: PMNode | null): InlineBoundary | null {
  if (!prev || prev.type.name === "hardBreak") return null;
  // Marks close in reverse, so the last closer belongs to the first non-shared mark.
  for (const m of prev.marks) {
    if (m.isInSet(node.marks)) continue;
    const d = MARK_CLOSE_CHAR[m.type.name];
    if (d) return { ch: d, text: false };
  }
  const t = prev.isText ? (prev.text ?? "") : "";
  if (t) return { ch: t[t.length - 1]!, text: true };
  if (prev.type.name === "footnoteReference") return { ch: "]", text: false };
  return null;
}

/**
 * Can whitespace at this flanked mark's edge stay inside the mark, held by a
 * character reference? Yes against text (respelt) or punctuation — unless the
 * neighbouring delimiter repeats this mark's own, because the two runs would fuse.
 */
function markEdgeHolds(node: PMNode, neighbour: PMNode | null, side: "lead" | "trail"): boolean {
  const b = side === "lead" ? boundaryBefore(node, neighbour) : boundaryAfter(node, neighbour);
  if (b === null) return false;
  if (b.text) return true;
  if (!flankSafeChar(b.ch)) return false;
  for (const m of node.marks) {
    if (!FLANKED_MARKS.has(m.type.name)) continue;
    if (neighbour && m.isInSet(neighbour.marks)) continue;
    if ((side === "lead" ? MARK_OPEN_CHAR : MARK_CLOSE_CHAR)[m.type.name] === b.ch) return false;
  }
  return true;
}

/**
 * Does `sibling` keep trailing (or, below, leading) whitespace inside a flanked
 * mark by character reference? Then its delimiter run has `;` on its inner side,
 * and `node` must put punctuation on the outer side by respelling its own edge.
 */
export function holdsTrailingEdge(sibling: PMNode | null, before: PMNode | null, node: PMNode): boolean {
  if (!sibling?.isText || !/[^\S\n]$/.test(sibling.text ?? "")) return false;
  return keptMarkEdges(sibling, before, node).trail;
}
export function holdsLeadingEdge(sibling: PMNode | null, node: PMNode, after: PMNode | null): boolean {
  if (!sibling?.isText || !/^[^\S\n]/.test(sibling.text ?? "")) return false;
  return keptMarkEdges(sibling, node, after).lead;
}

/** Respell the first / last code point as a character reference unless it is
 *  already punctuation or whitespace. Code points, so no surrogate is split. */
export function refFirstChar(s: string): string {
  const cp = s.codePointAt(0);
  if (cp === undefined || flankSafeChar(String.fromCodePoint(cp))) return s;
  return `&#${cp};` + s.slice(String.fromCodePoint(cp).length);
}
export function refLastChar(s: string): string {
  if (s === "") return s;
  const low = s.charCodeAt(s.length - 1);
  const width = low >= 0xdc00 && low <= 0xdfff && s.length > 1 ? 2 : 1;
  const cp = s.codePointAt(s.length - width)!;
  if (flankSafeChar(String.fromCodePoint(cp))) return s;
  return s.slice(0, s.length - width) + `&#${cp};`;
}

/** Whether a text node's leading / trailing whitespace sits where a flanked mark
 *  opens / closes and a character reference can hold it. `expelMarkEdgeWhitespace`
 *  and the text serializer must agree on this one predicate. */
export function keptMarkEdges(node: PMNode, prev: PMNode | null, next: PMNode | null): { lead: boolean; trail: boolean } {
  if (!node.isText || !node.marks.some((m) => FLANKED_MARKS.has(m.type.name))) return { lead: false, trail: false };
  const spans = (sibling: PMNode | null) =>
    node.marks.every((m) => !FLANKED_MARKS.has(m.type.name) || (sibling ? m.isInSet(sibling.marks) : false));
  return {
    lead: !spans(prev) && markEdgeHolds(node, prev, "lead"),
    trail: !spans(next) && markEdgeHolds(node, next, "trail"),
  };
}

/**
 * Move whitespace out of a flanked mark only where no character reference can
 * keep it inside: mid-line, at the mark's own opening/closing edge, against a
 * fusing delimiter. The moved run keeps the marks it shares with its new
 * neighbour. The text is preserved exactly and the result is a fixed point; the
 * mark boundary moves by one whitespace run.
 */
export function expelMarkEdgeWhitespace(node: PMNode): PMNode {
  if (node.type.spec.code) return node; // a code block's text is verbatim
  if (!node.isTextblock) {
    if (node.childCount === 0) return node;
    const kids: PMNode[] = [];
    let changed = false;
    node.forEach((child) => {
      const next = expelMarkEdgeWhitespace(child);
      changed ||= next !== child;
      kids.push(next);
    });
    // Rebuild only where something moved; this runs over the whole document on every serialize.
    return changed ? node.copy(Fragment.fromArray(kids)) : node;
  }
  const kids: PMNode[] = [];
  node.forEach((child) => kids.push(child));
  const out: PMNode[] = [];
  let touched = false;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]!;
    const text = child.isText ? (child.text ?? "") : "";
    if (!text || !child.marks.some((m) => FLANKED_MARKS.has(m.type.name))) {
      out.push(child);
      continue;
    }
    const prev = kids[i - 1] ?? null;
    const next = kids[i + 1] ?? null;
    // A hard break ends the line, so whitespace against one is at a line edge.
    const atLineStart = !prev || prev.type.name === "hardBreak";
    const atLineEnd = !next || next.type.name === "hardBreak";
    // Marks the expelled run may keep: the ones that span the boundary anyway.
    const keep = (sibling: PMNode | null) =>
      child.marks.filter((m) => !FLANKED_MARKS.has(m.type.name) || (sibling ? m.isInSet(sibling.marks) : false));
    const lead = /^[^\S\n]*/.exec(text)![0];
    const trail = /[^\S\n]*$/.exec(text)![0];
    const opensHere = keep(prev).length !== child.marks.length;
    const closesHere = keep(next).length !== child.marks.length;
    const held = keptMarkEdges(child, prev, next);
    const moveLead = lead && !atLineStart && opensHere && !held.lead;
    const moveTrail = trail && !atLineEnd && closesHere && !held.trail;
    if (!moveLead && !moveTrail) {
      out.push(child);
      continue;
    }
    touched = true;
    if (!/\S/.test(text)) {
      // All whitespace: there is no core to keep the mark on.
      out.push(child.mark(keep(moveLead ? prev : next)));
      continue;
    }
    if (moveLead) out.push(child.type.schema.text(lead, keep(prev)));
    const core = text.slice(moveLead ? lead.length : 0, moveTrail ? text.length - trail.length : text.length);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out.push((child as any).withText(core));
    if (moveTrail) out.push(child.type.schema.text(trail, keep(next)));
  }
  // `Fragment.fromArray` re-joins the runs whose marks now match.
  return touched ? node.copy(Fragment.fromArray(out)) : node;
}
