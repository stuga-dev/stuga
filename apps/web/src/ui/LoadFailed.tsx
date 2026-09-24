/**
 * A view's failed load, with a required Retry. Not an empty state: "nothing
 * here" and "the request failed" are different facts.
 */
import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertCircle } from "lucide-react";

interface LoadFailedProps {
  /** Names what failed, e.g. "Couldn't load Trash". */
  title?: string;
  description?: string;
  icon?: ReactNode;
  /** Should put the view back into its loading state, or the retry looks like it did nothing. */
  onRetry: () => void;
  isCompact?: boolean;
}

export function LoadFailed({
  title = "Couldn’t load",
  description = "Please try again in a moment.",
  icon,
  onRetry,
  isCompact = false,
}: LoadFailedProps) {
  return (
    <EmptyState
      isCompact={isCompact}
      title={title}
      description={description}
      icon={icon ?? <AlertCircle size={isCompact ? 22 : 28} />}
      actions={<Button label="Retry" variant="secondary" size="sm" onClick={onRetry} />}
    />
  );
}
