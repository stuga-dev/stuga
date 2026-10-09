import { useCallback, useRef, useState } from "react";
import { TableAi } from "../api";
import { citedSources } from "../ai/citations";
import type { ChatTurn } from "../ai/ChatTranscript";
import { t } from "../i18n/i18n";
import { presentServerMessage } from "../lib/http/server-messages";
import { failureText, tableActivityText, tableNoticeText } from "../ai/turn-text";

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

  const patchLast = useCallback((fn: (turn: ChatTurn) => ChatTurn) => {
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
      const history = turns.filter((turn) => turn.text.trim() !== "").map((turn) => ({ role: turn.role, content: turn.text }));
      setTurns((ts) => [...ts, { role: "user", text: prompt }, { role: "assistant", text: "", status: t("database.ai.thinking") }]);

      abortRef.current = TableAi.stream(
        docId,
        { prompt, activeTable, history, model, collectionId },
        {
          onToken: (text) => patchLast((turn) => ({ ...turn, text: turn.text + text, status: undefined })),
          onStatus: (activity) => patchLast((turn) => (turn.text ? turn : { ...turn, status: tableActivityText(activity) })),
          onDone: ({ staged, applied, citations, notice }) => {
            finish();
            const sources = citedSources(citations);
            patchLast((turn) => ({
              ...turn,
              status: undefined,
              ...(staged > 0 ? { staged } : {}),
              ...(applied > 0 ? { applied } : {}),
              ...(sources.length > 0 ? { sources, citations } : {}),
              ...(notice ? { notice: tableNoticeText(notice) } : {}),
            }));
          },
          onError: (message, failure) => {
            finish();
            const note = `⚠ ${failureText(failure) ?? presentServerMessage(message)}`;
            patchLast((turn) => ({ ...turn, status: undefined, text: turn.text ? `${turn.text}\n\n${note}` : note }));
          },
        },
      );
    },
    [docId, activeTable, model, collectionId, turns, streaming, patchLast, finish],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    finish();
    patchLast((turn) => ({ ...turn, status: undefined }));
  }, [finish, patchLast]);

  return { turns, streaming, model, setModel, collectionId, setCollectionId, send, stop };
}
