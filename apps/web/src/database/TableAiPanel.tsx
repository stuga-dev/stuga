/**
 * A database's AI co-author chat. The changes a turn stages go to the run
 * ledger and are decided in the banner above the grid, not here. Cited
 * documents show beside the reply and are never written into the data.
 */
import { useState } from "react";
import { Database } from "lucide-react";
import { AiScopePicker } from "../ai/AiScopePicker";
import { ChatComposer } from "../ai/ChatComposer";
import { ChatTranscript } from "../ai/ChatTranscript";
import { useTableAi } from "./use-table-ai";

export function TableAiPanel({
  docId,
  activeTable,
}: {
  docId: string;
  /** Display name of the table on screen (steers the model's defaults). */
  activeTable: string | null;
}) {
  const ai = useTableAi(docId, activeTable);
  const [draft, setDraft] = useState("");

  function onSend() {
    const prompt = draft.trim();
    if (!prompt || ai.streaming) return;
    setDraft("");
    ai.send(prompt);
  }

  return (
    <aside className="ai-panel" aria-label="AI co-author">
      <ChatTranscript
        turns={ai.turns}
        streaming={ai.streaming}
        reviewWhere="in the banner above the grid"
        empty={
          <>
            Ask for changes to this database — “add a Status column and mark the done rows”, “insert the Q3
            milestones”, “dedupe rows by Name”. Every change is proposed for your review before it lands.
          </>
        }
      />
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={onSend}
        onStop={ai.stop}
        streaming={ai.streaming}
        placeholder={
          ai.collectionId === null
            ? "Ask the AI to change this database…"
            : "Ask the AI to change this database, using your documents…"
        }
        canSend={draft.trim() !== ""}
        header={
          <AiScopePicker
            model={ai.model}
            onModelChange={ai.setModel}
            scope={ai.collectionId}
            onScopeChange={ai.setCollectionId}
            base={{ label: "This database only", icon: <Database size={15} /> }}
          />
        }
      />
    </aside>
  );
}
