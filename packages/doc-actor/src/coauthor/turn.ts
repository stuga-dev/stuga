/**
 * One in-app co-author turn. The turn ends in a proposal, never a direct edit:
 * everything the model wrote goes to this document's run ledger as a `panel`
 * run under `panel:<human>`, where the document's own setting decides, as for
 * any agent, whether it waits for the human who asked or applies at once.
 */
import type { AiEditsPayload, AiRequest, AiResponseChunk, AiCitation } from "@stuga/protocol/wire/doc-socket";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { decodeJson, encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { failureReason, runAgentTurn, type AgentActivity, type AiConfig, type ToolRunner } from "@stuga/ai";
import { applyStrEditsStrict } from "@stuga/crdt-ops";
import type { InternalApi, JobQueue } from "@stuga/runtime";
import { recordPanelPropose, type Refusals } from "../audit.js";
import { proposeRunEdit } from "../ledger/propose.js";
import type { RunLedger } from "../ledger/run-store.js";
import { safeSend, type DocSocket } from "../session.js";
import type { RateLimiter } from "../sync/gates.js";
import { crossDocTools, fetchInstructionStack, fetchReviewMode, hostAgentImages, proposeCrossDoc } from "./cross-doc.js";
import { clampAiRequest, loadAttachmentPixels, revisionScopes, sanitizeAttachments } from "./inputs.js";

/** Display name of the co-author on its run bar (matches the tables' panel). */
const PANEL_AGENT = "AI co-author";

export interface CoAuthorEnv {
  jobs: JobQueue<IndexMessage>;
  internal: InternalApi;
  /** Resolved once per turn, so a settings save mid-stream cannot move the turn to another endpoint. */
  ai: () => AiConfig;
}

function activityLabel(a: AgentActivity): string {
  switch (a.kind) {
    case "thinking":
      return "Thinking…";
    case "reading":
      return "Reading the document…";
    case "searching":
      return a.query ? `Searching for “${a.query}”…` : "Searching the knowledge base…";
    case "editing":
      return "Preparing edits…";
  }
}

/** Why staging failed, in the reviewer's language: the turn worked, the edit was refused. */
function proposeFailure(result: { error: string; message?: string }): string {
  switch (result.error) {
    case "locked":
      return "This document was locked before the changes could be proposed, so nothing was staged.";
    case "too_large":
      return "The result would be too large for one document, so nothing was staged.";
    case "unavailable":
      return "This document's edit ledger is temporarily unavailable — nothing was staged. Try again shortly.";
    case "stale":
      return "The document changed while the AI was writing, so its changes no longer applied.";
    default:
      return result.message ?? "The changes couldn't be proposed.";
  }
}

export class CoAuthor {
  /** The turn in flight per socket, so AI_CANCEL can abort it from outside the lock. */
  private readonly turns = new WeakMap<DocSocket, AbortController>();

  constructor(
    private readonly env: CoAuthorEnv,
    private readonly ledger: RunLedger,
    private readonly refusals: Refusals,
    private readonly rate: RateLimiter,
  ) {}

  /** Signal only: runs outside the lock. */
  cancel(ws: DocSocket): void {
    this.turns.get(ws)?.abort();
  }

  async handleRequest(ws: DocSocket, payload: Uint8Array): Promise<void> {
    const meta = ws.meta;
    const store = this.ledger.store;
    // An AI turn ends in a document edit, so it takes the write gates.
    if (store.locked) return this.refuse(ws, "locked", "This document is locked; unlock it to make changes.");
    if (!meta.canWrite) return this.refuse(ws, "acl", "You have view-only access to this document.");
    if (!this.rate.allow(ws, "ai")) return this.refuse(ws, "rate-limit", "Too many AI requests; try again shortly.");
    let req: AiRequest;
    try {
      req = clampAiRequest(decodeJson<AiRequest>(payload));
    } catch {
      return this.fail(ws, "The request could not be read.");
    }
    if (!req.prompt.trim()) return this.fail(ws, "Say what you'd like me to do.");
    await this.runTurn(ws, req);
  }

  private async runTurn(ws: DocSocket, req: AiRequest): Promise<void> {
    const meta = ws.meta;
    const store = this.ledger.store;
    const docId = store.docId;
    // A human surface: an agent driving it would mint a run it reviews itself. Agents have MCP.
    if (meta.agentAuth) return this.fail(ws, "Agents use the MCP tools, not the in-app co-author.");
    const ai = this.env.ai();
    if (!ai.chat.enabled) return this.fail(ws, "AI chat is disabled on this node");

    const panelAlias = `panel:${meta.alias}`;
    const controller = new AbortController();
    this.turns.set(ws, controller);
    const recordUsage = (usage: {
      model: string;
      status?: "error";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }): void => {
      void this.env.jobs
        .send({ kind: "ai_usage", alias: meta.alias, workspaceId: meta.workspaceId, docId: docId || null, usageKind: "coauthor", ...usage })
        .catch((e) => console.warn("recordAiUsage enqueue failed (usage ledger gap)", { docId, err: String(e) }));
    };

    try {
      // The document as this panel run's own pending hunks leave it, read once: a
      // panel turn proposes only at its end, so no hunk of its own appears mid-turn.
      const projection = await this.ledger.projectionFor(panelAlias);
      // Handed over below, once the model has seen it: a turn that fails first leaves it for the next.
      const feedback = await this.ledger.feedbackFor(panelAlias);
      // Reject and revise: the turn may change only the passages those rejections covered, in their full text.
      const scopes = revisionScopes(req.revise);
      const revise =
        scopes.length > 0
          ? { regions: (await Promise.all(scopes.map((s) => this.ledger.rejectedHunks(panelAlias, s.run_id, s.feedback_id)))).flat() }
          : undefined;
      const ownPending = projection.pending;
      // Per turn, so switching the setting applies to the next message. The run's
      // own undecided hunks hold this turn's edits back even on `auto`.
      const review = await fetchReviewMode(this.env.internal, docId, meta);
      const applyAtOnce = review === "auto" && ownPending.length === 0;
      const citations: AiCitation[] = [];
      const runner: ToolRunner = {
        // Re-serialized per call so a collaborator's concurrent edits show.
        readDocument: async ({ offset = 0, length = 12_000 }) => {
          const live = store.markdown();
          const view = ownPending.length > 0 ? applyStrEditsStrict(live, ownPending).markdown : live;
          return view.slice(offset, offset + length);
        },
        ...crossDocTools(this.env.internal, docId, meta, req.collection_id ?? null, citations),
      };

      const result = await runAgentTurn(
        ai,
        {
          prompt: req.prompt,
          docText: projection.markdown,
          selectedText: req.selected_text,
          model: req.model,
          history: req.history,
          collectionEnabled: !!req.collection_id,
          currentDocId: docId,
          applyAtOnce,
          // Per turn, so an edited instruction, or a move to another folder, applies to the next message.
          instructions: await fetchInstructionStack(this.env.internal, docId, meta),
          feedback,
          revise,
          // The preview has them applied; the user sees them marked and undecided.
          ownPending: ownPending.map((h) => ({ old_string: h.old_string, new_string: h.new_string })),
          attachments: await loadAttachmentPixels(this.env.internal, sanitizeAttachments(req.attachments), meta.workspaceId),
          signal: controller.signal,
        },
        runner,
        (chunk) => safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { chunk, done: false } satisfies AiResponseChunk)),
        (activity) =>
          safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { status: activityLabel(activity), done: false } satisfies AiResponseChunk)),
      );

      // The next turn hears only what the user rejects after this one.
      if (feedback.length > 0 && result.rounds > 0) await this.ledger.answerFeedback(panelAlias, feedback.map((f) => f.id));
      if (result.failure) console.warn("co-author model call failed", { docId, ...result.failure });
      const reason = failureReason(result.failure);
      // A partial turn (round cap, a later round failing) still proposes what its finished rounds staged.
      const incomplete =
        result.stopReason === "max_rounds"
          ? `Stopped after ${result.rounds} rounds of work. Ask me to continue if there's more to do.`
          : result.stopReason === "error"
            ? ["The turn ended early.", reason].filter(Boolean).join(" ")
            : null;
      const tokens = {
        model: result.modelId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadInputTokens,
        cacheWriteTokens: result.usage.cacheWriteInputTokens,
      };

      if (result.stopReason === "error" && result.strEdits.length === 0 && result.docEdits.length === 0 && !result.prose.trim()) {
        recordUsage({ ...tokens, status: "error" });
        return this.fail(ws, reason ?? "The AI turn failed.");
      }

      // Before staging, so the image destination in the diff is the one that lands.
      const mediaWarning = await hostAgentImages(this.env.internal, docId, result.strEdits, meta);

      let staged = 0;
      let applied = 0;
      let runId: string | null = null;
      let proposeError: string | null = null;
      if (result.strEdits.length > 0) {
        const status = applyAtOnce ? "Applying changes…" : "Proposing changes…";
        safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { status, done: false } satisfies AiResponseChunk));
        const out = await proposeRunEdit(this.ledger, {
          op: { action: "cited_edits", edits: result.strEdits, citations: result.citations },
          source: "panel",
          review,
          // In front of the reviewer who asked; mail would be noise.
          notifyReviewer: false,
          agent: PANEL_AGENT,
          agentAlias: panelAlias,
          model: result.modelId,
          reviewer: meta.alias,
          workspaceId: meta.workspaceId,
          // Only a notification reads it, and this run never notifies.
          docTitle: "",
        });
        if (out.mode === "proposed") {
          staged = out.pending;
          runId = out.run.id;
          recordPanelPropose(this.env.jobs, docId, meta, panelAlias, out.run.id, { mode: "proposed", pending: out.pending });
        } else if (out.mode === "auto_applied") {
          applied = out.applied;
          runId = out.run.id;
          recordPanelPropose(this.env.jobs, docId, meta, panelAlias, out.run.id, { mode: "auto_applied", seq: out.seq });
        } else if (out.mode === "error") {
          proposeError = proposeFailure(out);
        }
      }
      const crossDocs = await proposeCrossDoc(this.env.internal, result.docEdits, meta, req.collection_id ?? null, panelAlias, PANEL_AGENT);

      const stopped =
        result.stopReason !== "aborted"
          ? null
          : staged > 0 || crossDocs.some((d) => d.mode === "proposed")
            ? "Stopped. The changes it had already made are staged for review."
            : applied > 0 || crossDocs.some((d) => d.mode === "applied")
              ? "Stopped. The changes it had already made were applied."
              : "Stopped.";

      safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { done: true } satisfies AiResponseChunk));
      recordUsage(tokens);
      // Always the turn's last frame: the client ends the turn on it.
      safeSend(
        ws,
        encodeJson(Opcode.AI_EDITS, {
          staged,
          applied,
          run_id: runId,
          cross_docs: crossDocs,
          citations: result.citations,
          error: proposeError,
          notice: [incomplete, stopped, mediaWarning].filter(Boolean).join(" ") || null,
        } satisfies AiEditsPayload),
      );
    } catch (err) {
      // The resolved model id is unknown when the stream fails before its metadata.
      recordUsage({ model: req.model, status: "error" });
      this.fail(ws, (err as Error).message);
    } finally {
      this.turns.delete(ws);
    }
  }

  /** Refuse at the gate: WRITE_REJECTED carries the reason, AI_EDITS ends the turn. */
  private refuse(ws: DocSocket, kind: "locked" | "acl" | "rate-limit", message: string): void {
    this.refusals.reject(ws, kind, message);
    this.fail(ws, message);
  }

  /** End a turn with an error: the client shows it from AI_RESPONSE and clears the turn on AI_EDITS. */
  private fail(ws: DocSocket, error: string): void {
    safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { done: true, error } satisfies AiResponseChunk));
    safeSend(
      ws,
      encodeJson(Opcode.AI_EDITS, { staged: 0, applied: 0, run_id: null, cross_docs: [], error, notice: null } satisfies AiEditsPayload),
    );
  }
}
