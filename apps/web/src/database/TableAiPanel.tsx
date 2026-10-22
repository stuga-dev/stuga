/**
 * A database's AI co-author chat. The changes a turn stages go to the run
 * ledger and are decided in the banner above the grid, not here, or applied at
 * once on a database set that way. Cited documents show beside the reply and
 * are never written into the data.
 */
import { useState } from "react";
import { Database } from "lucide-react";
import { AiScopePicker } from "../ai/AiScopePicker";
import { ChatComposer } from "../ai/ChatComposer";
import { ChatTranscript } from "../ai/ChatTranscript";
import { useTableAi } from "./use-table-ai";
import { t, type MessageKey } from "../i18n/i18n";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { aiCoauthorLabel } from "../lib/format";

/** What an empty chat says of how its changes land, by the database's level. */
const EMPTY_NOTE: Record<ReviewMode, MessageKey> = {
  auto: "database.ai.emptyAuto",
  review: "database.ai.emptyReview",
  colleague: "database.ai.emptyColleague",
};

export function TableAiPanel({
  docId,
  activeTable,
  agentMode,
}: {
  docId: string;
  /** Display name of the table on screen (steers the model's defaults). */
  activeTable: string | null;
  /** How AI edits to the database are reviewed. */
  agentMode: ReviewMode;
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
    <aside className="ai-panel" aria-label={aiCoauthorLabel()}>
      <ChatTranscript
        turns={ai.turns}
        streaming={ai.streaming}
        reviewIn="grid"
        empty={
          <>
            {t("database.ai.empty")} {t(EMPTY_NOTE[agentMode])}
            {/* The table assistant reads this database alone until someone widens it; say where. */}
            {ai.collectionId === null && <> {t("database.ai.scopeHint")}</>}
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
          ai.collectionId === null ? t("database.ai.placeholder") : t("database.ai.placeholderDocs")
        }
        canSend={draft.trim() !== ""}
        header={
          <AiScopePicker
            model={ai.model}
            onModelChange={ai.setModel}
            scope={ai.collectionId}
            onScopeChange={ai.setCollectionId}
            base={{ label: t("database.ai.scopeBase"), icon: <Database size={15} /> }}
          />
        }
      />
    </aside>
  );
}
