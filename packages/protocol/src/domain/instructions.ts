/**
 * Instructions for agents, stacked. The workspace, every folder, and every
 * document or database can carry a block of free text for agents. The blocks
 * that apply to one item are ALL of them from the workspace down to the item,
 * outermost first: the workspace's, each folder's from the root down, the
 * database a row page belongs to, then the item's own. Nothing overrides or
 * hides another block; a nearer one refines a farther one. The blocks are
 * advice to the model and never enforcement: review mode and permissions decide
 * what an agent's write does.
 */
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "./limits.js";

/** The kinds of item a level is set on, outermost first. */
export const INSTRUCTION_LEVEL_KINDS = ["workspace", "folder", "database", "document"] as const;

export type InstructionLevelKind = (typeof INSTRUCTION_LEVEL_KINDS)[number];

function isInstructionLevelKind(value: unknown): value is InstructionLevelKind {
  return typeof value === "string" && (INSTRUCTION_LEVEL_KINDS as readonly string[]).includes(value);
}

export interface InstructionLevel {
  kind: InstructionLevelKind;
  /** The workspace_id, folder_id or doc_id the text is set on. */
  id: string;
  /** The workspace name, folder title or document title a person sees. */
  title: string;
  /** Trimmed and never empty: a level without text is left out of a stack. */
  text: string;
}

/**
 * The most text one stack hands a model. Each level is already capped at
 * MAX_AGENT_INSTRUCTIONS_CHARS when saved; this bounds a deep tree of full ones.
 */
export const MAX_AGENT_INSTRUCTIONS_STACK_CHARS = 60_000;

/**
 * The well-formed levels of an untrusted answer, in order: a level of an unknown
 * kind, or with a field that is not text, is dropped.
 */
export function parseInstructionLevels(value: unknown): InstructionLevel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (l): l is InstructionLevel =>
      !!l &&
      typeof l === "object" &&
      isInstructionLevelKind((l as InstructionLevel).kind) &&
      typeof (l as InstructionLevel).id === "string" &&
      typeof (l as InstructionLevel).title === "string" &&
      typeof (l as InstructionLevel).text === "string",
  );
}

/** The most of a title a label quotes. */
export const INSTRUCTION_TITLE_MAX = 200;

const LEVEL_NOUN: Record<InstructionLevelKind, string> = {
  workspace: "Workspace",
  folder: "Folder",
  database: "Database",
  document: "Document",
};

/**
 * A title as a label quotes it: one line, no double quote, at most
 * INSTRUCTION_TITLE_MAX characters, "Untitled" when blank. Anyone who can
 * rename an item sets its title, so a title must not be able to end the line
 * or the quotes it sits in and pass for a marker or a level of its own.
 */
export function instructionTitle(title: string): string {
  const flat = title.replace(/[\s\p{Cc}]+/gu, " ").replace(/"/g, "'").trim();
  if (!flat) return "Untitled";
  const chars = [...flat];
  return chars.length > INSTRUCTION_TITLE_MAX ? `${chars.slice(0, INSTRUCTION_TITLE_MAX - 1).join("")}…` : flat;
}

/** `Workspace "Acme"`, `Folder "Contracts"`, `Database "Tasks"`, `Document "Q3 plan"`. */
export function instructionLevelLabel(level: Pick<InstructionLevel, "kind" | "title">): string {
  return `${LEVEL_NOUN[level.kind]} "${instructionTitle(level.title)}"`;
}

/** Lines of a level's text that a renderer's markers could be mistaken for. */
const MARKER_LINE = /^\s*(?:<<<|INSTRUCTIONS\s*$|NOTE\s*$|\[NOTE\b|===|---\s.*\s---\s*$|Cut short or left out to fit:)/;

/**
 * A level's text as a renderer fences it: every line that looks like one of the
 * markers around it is prefixed with a backslash, so the text cannot close its
 * own block, open another or pose as a note. Line breaks become "\n", so no
 * other break can hide a marker. Deterministic, so a prompt built
 * from the same stack stays byte-identical; for rendering only, never stored.
 */
export function escapeInstructionText(text: string): string {
  return text
    .split(/\r\n?|\n|\u2028|\u2029/)
    .map((line) => (MARKER_LINE.test(line) ? `\\${line}` : line))
    .join("\n");
}

export interface FittedInstructionStack {
  /** The levels as they go to a model, in stack order; the last kept one may be cut short. */
  levels: InstructionLevel[];
  /** The levels (whole or cut) that did not fit, in stack order. Empty when nothing was lost. */
  cut: InstructionLevel[];
}

/**
 * The stack cut to what a model is handed, keeping stack order: a level over
 * the per-level cap is cut to it, and once the stack budget runs out the level
 * that crosses it is cut and every nearer one dropped. Order is kept rather than
 * favouring the nearest level, so what an agent reads is the same prefix a
 * person reads top-down in the dialog, and the dialog warns when it happens.
 */
export function fitInstructionStack(
  levels: readonly InstructionLevel[],
  budget: number = MAX_AGENT_INSTRUCTIONS_STACK_CHARS,
): FittedInstructionStack {
  const kept: InstructionLevel[] = [];
  const cut: InstructionLevel[] = [];
  let left = budget;
  for (const level of levels) {
    const text = level.text.trim();
    if (!text) continue;
    const allowed = Math.min(MAX_AGENT_INSTRUCTIONS_CHARS, left);
    if (allowed <= 0) {
      cut.push(level);
      continue;
    }
    if (text.length > allowed) {
      kept.push({ ...level, text: text.slice(0, allowed) });
      cut.push(level);
      left -= allowed;
      continue;
    }
    kept.push(text === level.text ? level : { ...level, text });
    left -= text.length;
  }
  return { levels: kept, cut };
}

/** The total characters a stack would hand a model before fitting. */
export function instructionStackChars(levels: readonly InstructionLevel[]): number {
  return levels.reduce((n, l) => n + l.text.trim().length, 0);
}

/** How a stack travels to an agent in an API or tool answer. */
export interface AgentInstructions {
  /** Outermost first, fitted to what a model is handed. Empty when nothing applies. */
  instructions: InstructionLevel[];
  /** Labels of the levels cut short or left out to fit; absent when nothing was. */
  instructions_cut?: string[];
}

/** The stack fitted and shaped for an agent-facing answer. */
export function agentInstructions(levels: readonly InstructionLevel[]): AgentInstructions {
  const fitted = fitInstructionStack(levels);
  return fitted.cut.length > 0
    ? { instructions: fitted.levels, instructions_cut: fitted.cut.map(instructionLevelLabel) }
    : { instructions: fitted.levels };
}
