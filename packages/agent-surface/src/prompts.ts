/**
 * The prompts a person starts from a client's prompt menu, so saving and asking never wait on the
 * model deciding to. Each one is a single plain line in the person's own voice, naming Stuga: a
 * client may show it as an attachment, and the tool descriptions already say what to do with it.
 */
import { z } from "zod";

/** What one save may be handed: a few points, or notes the model splits into them. */
export const SAVE_PROMPT_MAX_CHARS = 20_000;
/** What one ask may be handed: a question, or what it is about. */
export const ASK_PROMPT_MAX_CHARS = 2_000;
/** What one check may be narrowed to: a folder, or what it is about. */
export const CHECK_PROMPT_MAX_CHARS = 500;

export const PROMPT_NAMES = ["save", "ask", "check"] as const;

export type PromptName = (typeof PROMPT_NAMES)[number];

/** A type alias, not an interface: the MCP SDK's result type needs an implicit index signature. */
export type PromptResult = {
  description: string;
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
};

export interface PromptDefinition {
  title: string;
  description: string;
  argsSchema: z.ZodRawShape;
  /** It asks for a save, so a read-only connection is not offered it. A check only reads until a person approves its fixes. */
  saves: boolean;
  text(args: Record<string, string | undefined>): string;
}

const savePrompt: PromptDefinition = {
  title: "Save to Stuga",
  description: "Save something to your team wiki or your own notes in Stuga.",
  argsSchema: { text: z.string().min(1).max(SAVE_PROMPT_MAX_CHARS).describe("What to save, in your own words.") },
  saves: true,
  // The person's words behind the phrase `remember` answers to, nothing more: one shape, so it always
  // matches the template the extension's manifest declares.
  text({ text }) {
    return `Save to Stuga: ${(text ?? "").trim()}`;
  },
};

/** The ask's words before the person's: a whole request on its own, so it reads the same when they add none. */
const ASK_LEAD = "Ask Stuga what my team and I have recorded: say who wrote each point and when, and what still waits for approval.";

const askPrompt: PromptDefinition = {
  title: "Ask Stuga",
  description: "Ask what you and your team have recorded in Stuga.",
  argsSchema: {
    topic: z.string().max(ASK_PROMPT_MAX_CHARS).optional().describe("What you want to know: a question, or what it is about."),
  },
  saves: false,
  // One shape with a topic or without, so the template the extension's manifest declares, filled with
  // nothing, reads as this does.
  text({ topic }) {
    return `${ASK_LEAD} ${(topic ?? "").trim()}`.trimEnd();
  },
};

/** The check's words before the person's, a whole request on its own, as the ask's are. */
const CHECK_LEAD =
  "Check Stuga: find the pages that need checking, the pages nothing links to and the broken links, and propose fixes for my approval.";

const checkPrompt: PromptDefinition = {
  title: "Check Stuga",
  description: "Find pages in your Stuga wiki to look at again, and propose fixes for approval.",
  argsSchema: {
    scope: z.string().max(CHECK_PROMPT_MAX_CHARS).optional().describe("What to check: a folder, or what it is about. The whole wiki when left out."),
  },
  saves: false,
  text({ scope }) {
    return `${CHECK_LEAD} ${(scope ?? "").trim()}`.trimEnd();
  },
};

const DEFINITIONS: Record<PromptName, PromptDefinition> = { save: savePrompt, ask: askPrompt, check: checkPrompt };

export function promptDefinition(name: PromptName): PromptDefinition {
  return DEFINITIONS[name];
}

/** The prompt as a client receives it. */
export function buildPrompt(name: PromptName, args: Record<string, string | undefined>): PromptResult {
  const def = DEFINITIONS[name];
  return { description: def.description, messages: [{ role: "user", content: { type: "text", text: def.text(args) } }] };
}
