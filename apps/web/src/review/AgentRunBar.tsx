/**
 * The document's open agent runs, one banner each (with two agents working,
 * Accept all must mean one of them). The banner walks the run's hunks in
 * document order and opens the per-hunk list, the only way to decide a hunk
 * with no ghost.
 */
import { useState } from "react";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { Button } from "@astryxdesign/core/Button";
import { useAgentRuns, pendingHunks } from "./agent-runs-context";
import { RunChangeList } from "./RunChangeList";
import { RunBanner, RunNotices } from "./RunBanner";
import { itemKey } from "./run-ledger";
import type { HunkKey } from "../editor/run-preview/plan";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function AgentRunBar() {
  const { openRuns, notices, dismissNotice, revert } = useAgentRuns();
  return (
    <>
      <RunNotices notices={notices} dismissNotice={dismissNotice} onUndo={revert} />
      {openRuns.map((run) => (
        <AgentRunBanner key={run.id} run={run} />
      ))}
    </>
  );
}

function AgentRunBanner({ run }: { run: AgentRunSummary }) {
  const { busy, decide, preview } = useAgentRuns();
  /**
   * The navigator's position, held as the hunk's key because a decision drops
   * that hunk from the list under the cursor. `at` is the index it held, so a
   * vanished key hands the cursor to the change that took its place.
   */
  const [cursor, setCursor] = useState<{ key: HunkKey; at: number } | null>(null);

  const pending = pendingHunks(run);
  const n = run.hunks_truncated ? 0 : pending.length;

  // The overlay reports every open run's hunks; keep this run's, in document order.
  const mine = new Set(pending.map((h) => itemKey(run.id, h.id)));
  const anchored = preview.anchored.filter((k) => mine.has(k));
  const unanchoredCount = preview.unanchored.filter((k) => mine.has(k)).length;

  const parked = cursor === null ? -1 : anchored.indexOf(cursor.key);
  // A vanished key's slot now holds a change never shown, so the next ▸ lands on it.
  const at =
    cursor === null || anchored.length === 0 ? null : parked >= 0 ? parked : Math.min(cursor.at, anchored.length - 1);
  const visited = parked >= 0;

  function go(delta: number) {
    if (anchored.length === 0) return;
    const next =
      at === null
        ? delta > 0
          ? 0
          : anchored.length - 1
        : !visited && delta > 0
          ? at
          : (at + delta + anchored.length) % anchored.length;
    setCursor({ key: anchored[next]!, at: next });
    preview.scrollToHunk(anchored[next]!);
  }

  // The list is offered when it says something the ghosts can't.
  const hasList = n > 1 || run.hunks_truncated === true || unanchoredCount > 0;

  return (
    <RunBanner
      updatedAt={run.updated_at}
      title={n > 0 ? `${run.agent} proposes ${n} edit${n === 1 ? "" : "s"}` : `${run.agent} proposes edits`}
      hint={
        unanchoredCount > 0
          ? `${unanchoredCount} can’t be shown in the document — see “Review each”`
          : "nothing changes until you accept"
      }
      busy={busy}
      onDecide={(decision) => void decide(run.id, decision)}
      list={hasList ? <RunChangeList run={run} /> : undefined}
      controls={
        anchored.length > 0 && (
          <div className="agent-run-nav" role="group" aria-label="Move between this run's changes">
            <Button label="Previous change" variant="ghost" size="sm" isIconOnly icon={<ChevronLeft size={15} />} onClick={() => go(-1)} />
            <span className="agent-run-nav__count" aria-live="polite">
              {(at ?? 0) + 1} of {anchored.length}
            </span>
            <Button label="Next change" variant="ghost" size="sm" isIconOnly icon={<ChevronRight size={15} />} onClick={() => go(1)} />
          </div>
        )
      }
    />
  );
}
