/**
 * One in-app co-author turn. The turn ends in a proposal, never a direct edit:
 * everything the model wrote goes to this document's run ledger as a `panel`
 * run under `panel:<human>`, where the document's own setting decides, as for
 * any agent, whether it waits for the human who asked or applies at once.
 *
 * A thread turn answers the person's reply in a comment thread. Its request is
 * that reply, read from the node; it reaches only this document and the thread,
 * and its answer is posted there.
 */
import type { CoauthorActivity, CoauthorError, CoauthorNotice } from "@stuga/protocol/api/ai-turn";
import type { AiEditsPayload, AiRequest, AiResponseChunk, AiCitation, ThreadScope } from "@stuga/protocol/wire/doc-socket";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { decodeJson, encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { runAgentTurn, type AiConfig, type ToolRunner } from "@stuga/ai";
import { applyStrEditsStrict, markdownPlainText } from "@stuga/crdt-ops";
import { findFuzzyMatch } from "@stuga/protocol/text/fuzzy-match";
import type { InternalApi, JobQueue } from "@stuga/runtime";
import { recordPanelPropose, type Refusals } from "../audit.js";
import { proposeRunEdit } from "../ledger/propose.js";
import type { RunLedger } from "../ledger/run-store.js";
import { safeSend, type DocSocket, type SessionMeta } from "../session.js";
import type { RateLimiter } from "../sync/gates.js";
import { cleanHunkId, type CleanHunks } from "./clean-hunks.js";
import {
  crossDocTools,
  fetchCommentThread,
  fetchInstructionStack,
  fetchReviewMode,
  hostAgentImages,
  notifyAsked,
  postPanelComment,
  proposeCrossDoc,
} from "./cross-doc.js";
import { clampAiRequest, loadAttachmentPixels, revisionScopes, sanitizeAttachments } from "./inputs.js";
import { threadReplyText, threadTurn, type ThreadOutcomes, type ThreadTurn } from "./thread.js";

/** Display name of the co-author on its run bar (matches the tables' panel). */
const PANEL_AGENT = "AI co-author";

// i18n-exempt: tool results the model reads, never shown to a person.
const ASK_STOPPED = "the user stopped this turn; ask nothing more.";
const ASK_NOT_FOUND = "that text is not in the document exactly once as it reads now; quote a short exact phrase of existing text.";
const QUOTE_IN_EDIT =
  "that quote is in text an edit of yours changes (one from this turn, or one still waiting for the user's review), " +
  "so the comment would lose its place. Quote a phrase you are leaving as it is.";
const ASKED =
  "Posted in a comment on that passage. The user has not answered: their answer comes in a later turn, as a new request. " +
  "Do not assume an answer; go on only with what does not depend on it.";

/** What the co-author needs of this document's open sockets. */
export interface CoAuthorPeers {
  /** Tell every open page to re-read the comments: the node cannot reach this actor while a turn holds its lock. */
  broadcastComments(): void;
  /** Whether `alias` has a page open on this document; an agent's socket is not one. */
  personPresent(alias: string): boolean;
}

/** What the ask_in_comment tool hands the actor. */
type AskInput = Parameters<NonNullable<ToolRunner["askInComment"]>>[0];

/** What a turn's receipt says besides its edits: the questions it asked, and a thread turn's reply. */
type TurnOutcome = Pick<AiEditsPayload, "asked" | "replied">;

/** Whether a thread turn may run, or the receipt it ends on: a refusal, or the first answer to the same reply. */
type ThreadCheck = { turn: ThreadTurn } | { replay: AiEditsPayload } | { error: CoauthorError };

/** A thread turn that ended before its answer: no reply in the thread. */
const NO_REPLY: TurnOutcome = { asked: [], replied: null };

/** Whether a turn's answer stands well enough to post in public: what it made was not refused, and it was not stopped. */
function answerStands(stopReason: string, made: number, proposeError: CoauthorError | null, signal: AbortSignal): boolean {
  if (signal.aborted || proposeError !== null) return false;
  return stopReason === "complete" || (stopReason === "max_rounds" && made > 0);
}

/** The receipt of a turn that failed: nothing staged, the questions it had asked kept. */
function failedEdits(error: CoauthorError, outcome: TurnOutcome): AiEditsPayload {
  return { staged: 0, applied: 0, run_id: null, cross_docs: [], error, notices: [], ...outcome };
}

export interface CoAuthorEnv {
  jobs: JobQueue<IndexMessage>;
  internal: InternalApi;
  /** Resolved once per turn, so a settings save mid-stream cannot move the turn to another endpoint. */
  ai: () => AiConfig;
}

/** Why staging failed: the turn worked, the edit was refused. The app words it; `detail` is the ledger's own. */
function proposeFailure(result: { error: string; message?: string; count?: number }): CoauthorError {
  switch (result.error) {
    case "review_backlog":
      return { code: "review_backlog", count: result.count ?? 0 };
    case "locked":
      return { code: "propose_locked" };
    case "trashed":
      return { code: "trashed" };
    case "too_large":
      return { code: "too_large" };
    case "unavailable":
      return { code: "ledger_unavailable" };
    case "stale":
      return { code: "stale" };
    default:
      return result.message ? { code: "propose_failed", detail: result.message } : { code: "propose_failed" };
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
    private readonly peers: CoAuthorPeers,
    private readonly threads: ThreadOutcomes,
    private readonly clean: CleanHunks,
  ) {}

  /** Signal only: runs outside the lock. */
  cancel(ws: DocSocket): void {
    this.turns.get(ws)?.abort();
  }

  async handleRequest(ws: DocSocket, payload: Uint8Array): Promise<void> {
    const meta = ws.meta;
    const store = this.ledger.store;
    // An AI turn ends in a document edit, so it takes the write gates.
    if (store.locked) return this.refuse(ws, "locked", "This document is locked; unlock it to make changes.", { code: "locked" });
    if (store.trashed) return this.refuse(ws, "trashed", "This document is in the trash; restore it to make changes.", { code: "trashed" });
    if (!meta.canWrite) return this.refuse(ws, "acl", "You have view-only access to this document.", { code: "view_only" });
    if (!this.rate.allow(ws, "ai")) return this.refuse(ws, "rate-limit", "Too many AI requests; try again shortly.", { code: "rate_limited" });
    let req: AiRequest;
    try {
      req = clampAiRequest(decodeJson<AiRequest>(payload));
    } catch {
      return this.fail(ws, { code: "unreadable" });
    }
    // A thread turn's request is the person's reply, which the turn reads from the node.
    if (!req.thread && !req.prompt.trim()) return this.fail(ws, { code: "empty_prompt" });
    await this.runTurn(ws, req);
  }

  private async runTurn(ws: DocSocket, req: AiRequest): Promise<void> {
    const meta = ws.meta;
    const store = this.ledger.store;
    const docId = store.docId;
    // A human surface: an agent driving it would mint a run it reviews itself. Agents have MCP.
    if (meta.agentAuth) return this.fail(ws, { code: "agent" });
    const ai = this.env.ai();
    if (!ai.chat.enabled) return this.fail(ws, { code: "ai_disabled" });

    let thread: ThreadTurn | null = null;
    if (req.thread) {
      thread = await this.openThread(ws, req.thread);
      if (!thread) return;
    }

    const panelAlias = `panel:${meta.alias}`;
    const controller = new AbortController();
    this.turns.set(ws, controller);
    const asked: number[] = [];
    let replied: number | null = null;
    let staged = 0;
    let applied = 0;
    let proposedElsewhere = false;
    const outcome = (): TurnOutcome => (thread ? { asked: [...asked], replied } : { asked: [...asked] });
    // Only a thread turn that made something keeps its outcome: a failed or empty one runs again on Retry.
    const madeSomething = (): boolean => asked.length > 0 || replied !== null || staged + applied > 0 || proposedElsewhere;
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
      // A thread turn hears none, so it is still there for the next panel turn.
      const feedback = thread ? [] : await this.ledger.feedbackFor(panelAlias);
      // Reject and revise: the turn may change only the passages those rejections covered, in their full text.
      const scopes = revisionScopes(req.revise);
      const revise =
        scopes.length > 0
          ? { regions: (await Promise.all(scopes.map((s) => this.ledger.rejectedHunks(panelAlias, s.run_id, s.feedback_id)))).flat() }
          : undefined;
      const ownPending = projection.pending;
      // A comment is a public write review never sees, so only a turn whose context held nothing from
      // another document may post one: not by this turn's scope or this chat's, nor in a waiting edit.
      // A thread turn's context is this document, the thread and the waiting edits; it answers in the thread.
      // Rejected edits leave the clean set yet reach the model as feedback or a revision, so either blocks.
      const clean = await this.clean.read(meta.alias);
      const openRun = projection.runId;
      const pendingIds = openRun ? ownPending.map((h) => cleanHunkId(openRun, h.id)) : [];
      const pendingClean = clean !== null && pendingIds.every((id) => clean.has(id));
      const rejectedHeard = feedback.length > 0 || revise !== undefined;
      const cleanTurn = pendingClean && (thread !== null || (!req.collection_id && !req.history_scoped && !rejectedHeard));
      const mayAsk = !thread && cleanTurn;
      // Per turn, so switching the setting applies to the next message. The run's
      // own undecided hunks hold this turn's edits back even on `auto`.
      const review = await fetchReviewMode(this.env.internal, docId, meta);
      const applyAtOnce = review.mode === "auto" && ownPending.length === 0;
      const citations: AiCitation[] = [];
      const runner: ToolRunner = {
        // Re-serialized per call so a collaborator's concurrent edits show.
        readDocument: async ({ offset = 0, length = 12_000 }) => {
          const live = store.markdown();
          const view = ownPending.length > 0 ? applyStrEditsStrict(live, ownPending).markdown : live;
          return view.slice(offset, offset + length);
        },
        ...crossDocTools(this.env.internal, docId, meta, req.collection_id ?? null, citations),
        ...(mayAsk ? { askInComment: (q: AskInput) => this.askInComment(ws, controller.signal, asked, q) } : {}),
      };

      const result = await runAgentTurn(
        ai,
        {
          prompt: thread ? thread.prompt : req.prompt,
          docText: projection.markdown,
          selectedText: req.selected_text,
          model: req.model,
          history: req.history,
          collectionEnabled: !!req.collection_id,
          currentDocId: docId,
          applyAtOnce,
          colleagueApproves: review.mode === "colleague",
          // Per turn, so an edited instruction, or a move to another folder, applies to the next message.
          instructions: await fetchInstructionStack(this.env.internal, docId, meta),
          feedback,
          revise,
          // The preview has them applied; the user sees them marked and undecided.
          ownPending: ownPending.map((h) => ({ old_string: h.old_string, new_string: h.new_string })),
          attachments: await loadAttachmentPixels(this.env.internal, sanitizeAttachments(req.attachments), meta.workspaceId),
          signal: controller.signal,
          thread: thread?.context,
        },
        runner,
        (chunk) => safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { chunk, done: false } satisfies AiResponseChunk)),
        (activity) => safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { status: activity, done: false } satisfies AiResponseChunk)),
      );

      // The next turn hears only what the user rejects after this one.
      if (feedback.length > 0 && result.rounds > 0) await this.ledger.answerFeedback(panelAlias, feedback.map((f) => f.id));
      if (result.failure) console.warn("co-author model call failed", { docId, ...result.failure });
      const failure = result.failure?.kind ?? null;
      // A partial turn (round cap, a later round failing) still proposes what its finished rounds staged.
      const incomplete: CoauthorNotice | null =
        result.stopReason === "max_rounds"
          ? { code: "max_rounds", rounds: result.rounds }
          : result.stopReason === "error"
            ? { code: "ended_early", failure }
            : null;
      const tokens = {
        model: result.modelId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadInputTokens,
        cacheWriteTokens: result.usage.cacheWriteInputTokens,
      };

      // A question already posted is output: the turn ended early, not failed.
      const madeNothing = result.strEdits.length === 0 && result.docEdits.length === 0 && !result.prose.trim() && asked.length === 0;
      if (result.stopReason === "error" && madeNothing) {
        recordUsage({ ...tokens, status: "error" });
        const error: CoauthorError = { code: "failed", failure };
        // Not kept for a thread turn: it made nothing, so Retry runs it again.
        return this.end(ws, failedEdits(error, outcome()), error);
      }

      // Before staging, so the image destination in the diff is the one that lands. A thread turn
      // downloads nothing: a comment anyone could write must not steer an outbound fetch.
      const imageNotices = thread ? [] : await hostAgentImages(this.env.internal, docId, result.strEdits, meta);

      let runId: string | null = null;
      let hunkIds: string[] = [];
      let waiting: string[] = [];
      let proposeError: CoauthorError | null = null;
      if (result.strEdits.length > 0) {
        const status: CoauthorActivity = { kind: applyAtOnce ? "applying" : "proposing" };
        safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { status, done: false } satisfies AiResponseChunk));
        const out = await proposeRunEdit(this.ledger, {
          op: { action: "cited_edits", edits: result.strEdits, citations: result.citations },
          source: "panel",
          review: review.mode,
          approverGroup: review.approverGroup,
          // In front of the reviewer who asked; mail would be noise. Approvers at `colleague` are still told.
          notifyReviewer: false,
          agent: PANEL_AGENT,
          agentAlias: panelAlias,
          model: result.modelId,
          reviewer: meta.alias,
          workspaceId: meta.workspaceId,
          // Only a notification reads it: the approvers' at `colleague`.
          docTitle: review.title,
        });
        if (out.mode === "proposed") {
          staged = out.pending;
          runId = out.run.id;
          hunkIds = out.hunkIds;
          waiting = out.hunkIds.map((id) => cleanHunkId(out.run.id, id));
          recordPanelPropose(this.env.jobs, docId, meta, panelAlias, out.run.id, { mode: "proposed", pending: out.pending });
        } else if (out.mode === "auto_applied") {
          applied = out.applied;
          runId = out.run.id;
          hunkIds = out.hunkIds;
          recordPanelPropose(this.env.jobs, docId, meta, panelAlias, out.run.id, { mode: "auto_applied", seq: out.seq });
        } else if (out.mode === "error") {
          proposeError = proposeFailure(out);
        }
      }
      if (clean !== null) await this.keepClean(meta.alias, clean, pendingIds, cleanTurn ? waiting : []);
      const crossDocs = await proposeCrossDoc(this.env.internal, result.docEdits, meta, req.collection_id ?? null, PANEL_AGENT);
      proposedElsewhere = crossDocs.some((d) => d.mode !== "error");

      const stopped: CoauthorNotice | null =
        result.stopReason !== "aborted"
          ? null
          : {
              code: "stopped",
              kept:
                staged > 0 || crossDocs.some((d) => d.mode === "proposed")
                  ? "staged"
                  : applied > 0 || crossDocs.some((d) => d.mode === "applied")
                    ? "applied"
                    : null,
            };

      const notices = [incomplete, stopped, ...imageNotices].filter((n): n is CoauthorNotice => n !== null);
      // The full prose stays in the panel; the thread gets the final answer, without the narration of
      // earlier rounds, and only when the turn stands and has words.
      const stands = thread !== null && answerStands(result.stopReason, staged + applied, proposeError, controller.signal);
      const answer = stands ? threadReplyText(result.answer.trim() ? result.answer : result.prose) : "";
      if (thread && answer) {
        // A waiting edit in front of the model may hold text from another document: the answer stays in the panel.
        if (!cleanTurn) notices.push({ code: "reply_withheld" });
        else {
          replied = await this.replyInThread(ws, thread, answer);
          if (replied === null) notices.push({ code: "reply_failed" });
        }
      }

      recordUsage(tokens);
      const edits: AiEditsPayload = {
        staged,
        applied,
        run_id: runId,
        ...(hunkIds.length > 0 ? { hunk_ids: hunkIds } : {}),
        cross_docs: crossDocs,
        citations: result.citations,
        error: proposeError,
        notices,
        ...outcome(),
      };
      // Before the receipt, so a retry queued behind this turn finds it.
      if (thread && madeSomething()) await this.threads.record(meta.alias, thread.key, edits);
      this.end(ws, edits);
    } catch (err) {
      // The resolved model id is unknown when the stream fails before its metadata.
      recordUsage({ model: req.model, status: "error" });
      const error: CoauthorError = { code: "failed", failure: null, detail: (err as Error).message };
      const edits = failedEdits(error, outcome());
      if (thread && madeSomething()) await this.threads.record(meta.alias, thread.key, edits);
      this.end(ws, edits, error);
    } finally {
      this.turns.delete(ws);
      // A question the person was not here to see reaches them as a notification.
      if (asked.length > 0 && !this.peers.personPresent(meta.alias)) await notifyAsked(this.env.internal, docId, meta, [...asked]);
    }
  }

  /**
   * Read the thread a thread turn answers, through the node, and check the turn may run: the thread
   * is open, the reply is the person's own in it, and they may write now (a socket's tier can be
   * stale). A reply already answered gets its first receipt again. Null when the turn ended here.
   */
  private async openThread(ws: DocSocket, scope: ThreadScope): Promise<ThreadTurn | null> {
    let check: ThreadCheck;
    try {
      check = await this.checkThread(ws.meta, scope);
    } catch (err) {
      check = { error: { code: "failed", failure: null, detail: (err as Error).message } };
    }
    if ("turn" in check) return check.turn;
    if ("replay" in check) this.end(ws, check.replay);
    else if (check.error.code === "view_only") this.refuse(ws, "acl", "You have view-only access to this document.", check.error, NO_REPLY);
    else this.fail(ws, check.error, NO_REPLY);
    return null;
  }

  private async checkThread(meta: SessionMeta, scope: ThreadScope): Promise<ThreadCheck> {
    const thread = await fetchCommentThread(this.env.internal, this.ledger.store.docId, meta, scope.num);
    if (!thread || thread.resolved) return { error: { code: "thread_closed" } };
    if (!thread.can_write) return { error: { code: "view_only" } };
    const turn = threadTurn(thread, scope, meta.alias);
    if (!turn) return { error: { code: "thread_closed" } };
    // A retry after a dropped socket queues behind the first turn, and is told what that one did.
    const replay = await this.threads.get(meta.alias, turn.key);
    if (replay) return { replay };
    if (!turn.prompt.trim()) return { error: { code: "empty_prompt" } };
    return { turn };
  }

  /**
   * Keep the person's clean hunks to those still waiting, plus the ones this turn staged when its
   * context was clean; a decided hunk leaves the set.
   */
  private async keepClean(alias: string, clean: Set<string>, pendingIds: string[], staged: string[]): Promise<void> {
    const kept = pendingIds.filter((id) => clean.has(id));
    if (staged.length > 0 || kept.length !== clean.size) await this.clean.write(alias, [...kept, ...staged]);
  }

  /** Post a thread turn's answer as a reply in its thread; null when the node refused it. */
  private async replyInThread(ws: DocSocket, thread: ThreadTurn, body: string): Promise<number | null> {
    const docId = this.ledger.store.docId;
    const posted = await postPanelComment(this.env.internal, docId, ws.meta, {
      body,
      parent_num: thread.scope.num,
      parent_created_at: thread.rootCreatedAt,
    });
    if ("error" in posted) {
      console.warn("co-author reply not posted", { docId, num: thread.scope.num, reason: posted.error });
      return null;
    }
    this.peers.broadcastComments();
    return posted.num;
  }

  /**
   * The ask_in_comment tool: a question anchored where the quote sits in the live document, posted at
   * once so the person sees it while the turn runs. Each refusal is worded for the model.
   */
  private async askInComment(ws: DocSocket, signal: AbortSignal, asked: number[], q: AskInput): Promise<string> {
    if (signal.aborted) throw new Error(ASK_STOPPED);
    const anchor = this.ledger.store.quoteAnchor(q.quote);
    if (!anchor) throw new Error(ASK_NOT_FOUND);
    // The words must still be there once this turn's edits and the waiting ones land, or the comment
    // loses its place. Both are read as plain text, so formatting and block breaks cannot hide a change.
    if (!findFuzzyMatch(markdownPlainText(q.working), anchor.quote, { wantUnique: true })) throw new Error(QUOTE_IN_EDIT);
    const posted = await postPanelComment(this.env.internal, this.ledger.store.docId, ws.meta, {
      body: q.question,
      anchor_start: anchor.start,
      anchor_end: anchor.end,
      anchor_quote: anchor.quote,
    });
    if ("error" in posted) throw new Error(`the question could not be posted: ${posted.error}. Put it in your reply instead.`);
    this.peers.broadcastComments();
    asked.push(posted.num);
    return ASKED;
  }

  /** Refuse at the gate: WRITE_REJECTED carries the reason for the page, AI_EDITS ends the turn. */
  private refuse(
    ws: DocSocket,
    kind: "locked" | "trashed" | "acl" | "rate-limit",
    message: string,
    error: CoauthorError,
    outcome: TurnOutcome = { asked: [] },
  ): void {
    this.refusals.reject(ws, kind, message);
    this.fail(ws, error, outcome);
  }

  /** End a turn with an error: the client shows it from AI_EDITS, which also clears the turn. */
  private fail(ws: DocSocket, error: CoauthorError, outcome: TurnOutcome = { asked: [] }): void {
    this.end(ws, failedEdits(error, outcome), error);
  }

  /** A turn's last two frames: AI_RESPONSE `done`, then the AI_EDITS receipt the client ends the turn on. */
  private end(ws: DocSocket, edits: AiEditsPayload, error?: CoauthorError): void {
    safeSend(ws, encodeJson(Opcode.AI_RESPONSE, { done: true, ...(error ? { error } : {}) } satisfies AiResponseChunk));
    safeSend(ws, encodeJson(Opcode.AI_EDITS, edits satisfies AiEditsPayload));
  }
}
