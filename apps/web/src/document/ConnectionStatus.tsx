/**
 * The connection indicator: a dot that grows into a labelled pill as delivery
 * confidence drops. Every decision is made in sync/link-health.
 */
import { StatusDot } from "@astryxdesign/core/StatusDot";
import type { IndicatorReadout } from "../sync/link-health";

export function ConnectionStatus({ status }: { status: IndicatorReadout }) {
  return (
    <span
      className="conn-status"
      data-phase={status.phase}
      data-tone={status.tone}
      data-expanded={status.expanded ? "true" : "false"}
      data-testid="connection-status"
      // The one accessible surface: the full sentence, even while collapsed to a dot.
      role="status"
      aria-label={status.srText}
      title={status.srText}
    >
      {/* StatusDot requires a label; hidden, or the sentence is read twice. */}
      <StatusDot
        variant={status.tone}
        label={status.srText}
        aria-hidden="true"
        // Only while first connecting; a persistent alert should not move.
        isPulsing={status.phase === "connecting"}
      />
      {status.label && (
        <span className="conn-status__label" aria-hidden="true">
          {status.label}
        </span>
      )}
    </span>
  );
}
