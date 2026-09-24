import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import type { AskDone, AskStep } from "@stuga/protocol/api/ask";
import { api } from "../lib/http/client";
import { openSse } from "../lib/http/sse";

/** A saved research conversation. Owner-private within a workspace. */
interface AskThread {
  thread_id: string;
  workspace_id: string;
  owner: string;
  title: string;
  collection_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AskThreadSummary extends AskThread {
  turn_count: number;
  last_question: string | null;
}

/** One stored exchange; `answer` is Markdown with its [^n] markers. */
export interface AskTurn {
  thread_id: string;
  seq: number;
  question: string;
  answer: string;
  citations: AiCitation[];
  steps: AskStep[];
  created_at: string;
}

export const AskThreads = {
  list: () => api<{ threads: AskThreadSummary[] }>("/api/ask/threads"),
  create: (input: { title?: string; collectionId?: string | null } = {}) =>
    api<AskThread>("/api/ask/threads", {
      method: "POST",
      body: JSON.stringify({ title: input.title, collection_id: input.collectionId ?? undefined }),
    }),
  get: (id: string) => api<{ thread: AskThread; turns: AskTurn[] }>(`/api/ask/threads/${id}`),
  rename: (id: string, title: string) =>
    api<AskThread>(`/api/ask/threads/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  remove: (id: string) => api<{ deleted: boolean }>(`/api/ask/threads/${id}`, { method: "DELETE" }),
};

interface AskCallbacks {
  onToken: (text: string) => void;
  /** Replaces the previous activity label. */
  onStatus: (label: string) => void;
  onStep: (step: AskStep) => void;
  /** Discard the streamed text: the agent answered without reading the documents and is being sent back. */
  onReset: () => void;
  onDone: (result: AskDone) => void;
  onError: (message: string) => void;
}

export const Ask = {
  /** Abort the returned controller to stop the turn, on the server too. `collectionId` scopes retrieval. */
  stream: (
    question: string,
    opts: {
      collectionId?: string | null;
      /** Persist the turn here; the server then reads the history from the thread and ignores `history`. */
      threadId?: string | null;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    },
    cb: AskCallbacks,
  ): AbortController =>
    openSse(
      "/api/ask",
      {
        question,
        collection_id: opts.collectionId ?? undefined,
        thread_id: opts.threadId ?? undefined,
        history: opts.history ?? [],
      },
      {
        onEvent: (ev, data) => {
          if (ev === "token") cb.onToken(data.text as string);
          else if (ev === "status") cb.onStatus(data.label as string);
          else if (ev === "step") cb.onStep(data as unknown as AskStep);
          else if (ev === "reset") cb.onReset();
          else if (ev === "done") cb.onDone(data as unknown as AskDone);
          else if (ev === "error") cb.onError(data.message as string);
        },
        onError: cb.onError,
      },
      "ask failed",
    ),
};
