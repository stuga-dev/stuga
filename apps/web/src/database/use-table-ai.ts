import { useCallback, useRef, useState } from "react";
import { TableAi } from "../api";
import { citedSources } from "../ai/citations";
import type { ChatTurn } from "../ai/ChatTranscript";

/**
 * Conversation state for a database's AI co-author. The turn streams over SSE;
 * its changes land in the database's run ledger, so a turn only records how
 * many it proposed. The conversation lives as long as the panel.
 */
export function useTableAi(docId: string, activeTable: string | null) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState("auto");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const patchLast = useCallback((fn: (t: ChatTurn) => ChatTurn) => {
    setTurns((ts) => {
      const last = ts[ts.length - 1];
      return last?.role === "assistant" ? [...ts.slice(0, -1), fn(last)] : ts;
    });
  }, []);

  const finish = useCallback(() => {
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    (prompt: string) => {
      if (!prompt || streaming) return;
      setStreaming(true);
      // A blank assistant turn (stopped before the first token) would fail every later model call.
      const history = turns.filter((t) => t.text.trim() !== "").map((t) => ({ role: t.role, content: t.text }));
      setTurns((ts) => [...ts, { role: "user", text: prompt }, { role: "assistant", text: "", status: "Thinking…" }]);

      abortRef.current = TableAi.stream(
        docId,
        { prompt, activeTable, history, model, collectionId },
        {
          onToken: (text) => patchLast((t) => ({ ...t, text: t.text + text, status: undefined })),
          onStatus: (label) => patchLast((t) => (t.text ? t : { ...t, status: label })),
          onDone: (staged, _runId, citations, notice) => {
            finish();
            const sources = citedSources(citations);
            patchLast((t) => ({
              ...t,
              status: undefined,
              ...(staged > 0 ? { staged } : {}),
              ...(sources.length > 0 ? { sources, citations } : {}),
              ...(notice ? { notice } : {}),
            }));
          },
          onError: (message) => {
            finish();
            const note = `⚠ ${message}`;
            patchLast((t) => ({ ...t, status: undefined, text: t.text ? `${t.text}\n\n${note}` : note }));
          },
        },
      );
    },
    [docId, activeTable, model, collectionId, turns, streaming, patchLast, finish],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    finish();
    patchLast((t) => ({ ...t, status: undefined }));
  }, [finish, patchLast]);

  return { turns, streaming, model, setModel, collectionId, setCollectionId, send, stop };
}
