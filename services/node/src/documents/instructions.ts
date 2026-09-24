/**
 * Instructions for agents, resolved for one caller. The stack keeps only the
 * folder and database levels the caller's principals can read (the person
 * behind a key, never narrowed by the key's folder scope); see
 * `@stuga/db` resolveDocInstructions.
 */
import { resolveDocInstructions, resolveFolderInstructions, type DocRow } from "@stuga/db";
import type { ProposeInstructionLabels } from "@stuga/agent-surface/backend";
import {
  agentInstructions,
  instructionLevelLabel,
  type AgentInstructions,
  type InstructionLevel,
} from "@stuga/protocol/domain/instructions";
import type { Ctx } from "../auth/context.js";

/** Every level that applies to the document for this caller, outermost first, ending with its own. */
export function docInstructionStack(ctx: Ctx, doc: DocRow): Promise<InstructionLevel[]> {
  return resolveDocInstructions(ctx.sql, doc, ctx.principals);
}

/** Every level that applies beneath the folder for this caller, ending with the folder's own; null is the top level. */
export function folderInstructionStack(ctx: Ctx, folderId: string | null): Promise<InstructionLevel[]> {
  return resolveFolderInstructions(ctx.sql, ctx.workspaceId, folderId, ctx.principals);
}

/** The stack without the item's own level: what the item inherits. An item without text of its own inherits it all. */
export function inheritedLevels(stack: readonly InstructionLevel[], ownId: string): InstructionLevel[] {
  return stack.at(-1)?.id === ownId ? stack.slice(0, -1) : [...stack];
}

/** The document's stack as an agent-facing answer carries it. */
export async function docAgentInstructions(ctx: Ctx, doc: DocRow): Promise<AgentInstructions> {
  return agentInstructions(await docInstructionStack(ctx, doc));
}

/**
 * The stack for an answer to a write that has already happened, such as a create: a failed lookup leaves the
 * fields out rather than failing an answer the agent would read as a failed write and repeat. Its next read of the
 * item brings them.
 */
export async function docAgentInstructionsOrNone(ctx: Ctx, doc: DocRow): Promise<Partial<AgentInstructions>> {
  try {
    return await docAgentInstructions(ctx, doc);
  } catch (e) {
    console.warn("[node] instructions for agents unavailable for a created item", { docId: doc.doc_id, err: String(e) });
    return {};
  }
}

/**
 * For a write's answer: the labels of the levels below the workspace that apply to the document, so an agent that
 * wrote without reading learns they exist. The workspace's own reach an agent when it connects, and leaving them out
 * keeps the answer unchanged where only they apply. Best-effort like a create's: the write has already happened.
 */
export async function docInstructionLabelsOrNone(ctx: Ctx, doc: DocRow): Promise<ProposeInstructionLabels> {
  try {
    const below = (await docInstructionStack(ctx, doc)).filter((l) => l.kind !== "workspace");
    return below.length > 0 ? { instructions_labels: below.map(instructionLevelLabel) } : {};
  } catch (e) {
    console.warn("[node] instructions for agents unavailable for a write's answer", { docId: doc.doc_id, err: String(e) });
    return {};
  }
}
