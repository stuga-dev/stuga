/**
 * A view's failed load, with a required Retry. Not an empty state: "nothing
 * here" and "the request failed" are different facts. While the browser has no
 * network it says so instead, and retries by itself when the network is back.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertCircle } from "lucide-react";
import { t } from "../i18n/i18n";
import { useOnline } from "../lib/use-online";

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
  title = t("ui.loadFailed.title"),
  description = t("ui.loadFailed.description"),
  icon,
  onRetry,
  isCompact = false,
}: LoadFailedProps) {
  const online = useOnline();
  const wasOnline = useRef(online);
  useEffect(() => {
    const back = online && !wasOnline.current;
    wasOnline.current = online;
    if (back) onRetry();
  }, [online, onRetry]);
  return (
    <EmptyState
      isCompact={isCompact}
      title={online ? title : t("ui.loadFailed.offlineTitle")}
      description={online ? description : t("ui.loadFailed.offlineDescription")}
      icon={icon ?? <AlertCircle size={isCompact ? 22 : 28} />}
      actions={<Button label={t("common.retry")} variant="secondary" size="sm" onClick={onRetry} />}
    />
  );
}
