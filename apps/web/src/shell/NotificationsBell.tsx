/**
 * The notification tray in every TopNav. Opening it marks everything read, but
 * rows that were unread stay highlighted until it closes. It lists every
 * workspace the person belongs to; opening a row from another switches there.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Popover } from "@astryxdesign/core/Popover";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List } from "@astryxdesign/core/List";
import { Item } from "@astryxdesign/core/Item";
import { Text } from "@astryxdesign/core/Text";
import { Bell } from "lucide-react";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/session/workspace-pointer";
import type { Notification } from "../api";
import { useNotifications } from "../state/notifications";
import { relativeTime } from "../lib/format";

/**
 * The path of a notification's stored URL. The host is dropped, so the
 * navigation cannot leave this origin whatever PUBLIC_ORIGIN wrote the row.
 */
function safeInternalPath(raw: string): string | null {
  try {
    const u = new URL(raw, window.location.origin);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

function present(n: Notification): { label: string; to: string | null } {
  // A row without a title is named by its event: "REQUEST_ACCESS" → "Request access".
  const fallback = n.event_type.replace(/_/g, " ").toLowerCase();
  const label = n.resource_title ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
  const to = n.resource_id
    ? `/doc/${n.resource_id}`
    : n.resource_url
      ? safeInternalPath(n.resource_url)
      : null;
  return { label, to };
}

/** A target in another workspace switches there and reloads, like WorkspaceSwitcher. A row about the node is in none. */
function openTarget(n: Notification, to: string, nav: (to: string) => void): void {
  if (n.workspace_id === null || n.workspace_id === getActiveWorkspace()) {
    nav(to);
    return;
  }
  setActiveWorkspace(n.workspace_id);
  window.location.assign(to);
}

export function NotificationsBell() {
  const nav = useNavigate();
  const active = getActiveWorkspace();
  const { notifications, rowsFailed, unread, markAllRead, loadRows } = useNotifications();
  const [open, setOpen] = useState(false);
  /** The unread count the open tray last pulled rows for. */
  const pulledAt = useRef<number | null>(null);
  /** Rows unread while the tray is open, highlighted until it closes. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());

  // Rows load on open, and again only when the count rises while open: marking read lowers it.
  useEffect(() => {
    if (!open) {
      pulledAt.current = null;
      return;
    }
    const previous = pulledAt.current;
    pulledAt.current = unread;
    if (previous === null || unread > previous) loadRows();
  }, [open, unread, loadRows]);

  // Marks whatever lands while the tray is open, since rows arrive after the open click.
  useEffect(() => {
    if (!open) return;
    const unreadIds = (notifications ?? []).filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    setFresh((cur) => new Set([...cur, ...unreadIds]));
    void markAllRead();
  }, [open, notifications, markAllRead]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setFresh(new Set());
  }

  return (
    <Popover
      isOpen={open}
      onOpenChange={handleOpenChange}
      placement="below"
      alignment="end"
      width={340}
      label="Notifications"
      content={
        <List hasDividers header={<Text type="label">Notifications</Text>}>
          {(notifications ?? []).map((n) => {
            const { label, to } = present(n);
            return (
              <Item
                as="li"
                key={n.id}
                label={label}
                description={n.workspace_id !== null && n.workspace_id !== active ? (n.workspace_name ?? undefined) : undefined}
                isHighlighted={fresh.has(n.id) || !n.read}
                endContent={
                  <Text type="supporting" color="secondary">
                    {relativeTime(n.created_at)}
                  </Text>
                }
                onClick={
                  to
                    ? () => {
                        setOpen(false);
                        openTarget(n, to, nav);
                      }
                    : undefined
                }
              />
            );
          })}
          {/* The count comes from a separate request, so the all-clear shows only when it agrees. */}
          {notifications !== null && notifications.length === 0 && (
            <li className="notif-empty">
              <Text type="supporting" color="secondary">
                {rowsFailed
                  ? "Couldn’t load notifications."
                  : unread > 0
                    ? "Couldn’t show these notifications."
                    : "You’re all caught up."}
              </Text>
            </li>
          )}
        </List>
      }
    >
      <span className="notif-trigger">
        <IconButton
          label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
          variant="ghost"
          icon={<Bell size={18} />}
        />
        {unread > 0 && <span className="notif-dot" aria-hidden="true" />}
      </span>
    </Popover>
  );
}
