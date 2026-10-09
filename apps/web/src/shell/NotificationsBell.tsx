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
import { parseDeliveryError, type DeliveryErrorCode } from "@stuga/protocol/notify/events";
import { renderNotification } from "@stuga/protocol/notify/render";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/session/workspace-pointer";
import type { Notification } from "../api";
import { useNotifications } from "../state/notifications";
import { relativeTime } from "../lib/format";
import { t, uiLanguage, type MessageKey } from "../i18n/i18n";

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

/** The language a notification is written in: the interface's, English under pseudo-text. */
function notificationLanguage(): string {
  const lang = uiLanguage();
  return lang === "en-XA" ? "en" : lang;
}

function present(n: Notification): { label: string; to: string | null } {
  // Written from the event and its params in the reader's language; an event this build does not
  // know reads its resource's title, else its type.
  const label =
    renderNotification(n.event_type, n.payload ?? {}, notificationLanguage())?.title ??
    n.resource_title ??
    n.event_type; // i18n-exempt: an identifier, for an event no catalog knows
  const to = n.resource_id
    ? `/doc/${n.resource_id}`
    : n.resource_url
      ? safeInternalPath(n.resource_url)
      : null;
  return { label, to };
}

/** A channel as the tray names it: the services by their names, the rest in the reader's words. */
function channelName(sink: string): string {
  switch (sink) {
    case "email":
      return t("notifications.channel.email");
    case "webhook":
      return t("notifications.channel.webhook");
    case "slack":
      return "Slack"; // i18n-exempt: a product name
    case "teams":
      return "Teams"; // i18n-exempt: a product name
    case "discord":
      return "Discord"; // i18n-exempt: a product name
    default:
      return sink;
  }
}

const NOT_SENT: Record<DeliveryErrorCode, MessageKey> = {
  email_not_set_up: "notifications.delivery.emailNotSetUp",
  no_email_address: "notifications.delivery.noEmailAddress",
  no_sink: "notifications.delivery.noSink",
  no_webhook_url: "notifications.delivery.noWebhookUrl",
  channel_changed: "notifications.delivery.channelChanged",
  node_restarted: "notifications.delivery.nodeRestarted",
  not_sent: "notifications.delivery.notSent",
};

/** Why a delivery did not happen, from the code its row keeps. */
function notSentLine(channel: string, stored: string): string {
  const why = parseDeliveryError(stored);
  if (why.code === "sink_answered") return t("notifications.delivery.sinkAnswered", { channel, status: why.status });
  if (why.code === "failed") return t("notifications.delivery.failed", { channel, detail: why.detail.replace(/\.$/, "") });
  return t(NOT_SENT[why.code], { channel });
}

/**
 * Whether a notification about the node or one's own account also went out by the node's channel:
 * so nobody believes an alert reached their inbox when it did not. Nothing for a row from before
 * this was recorded.
 */
export function deliveryLine(n: Pick<Notification, "delivery_channel" | "delivered_at" | "delivery_error">): string | undefined {
  if (!n.delivery_channel) return undefined;
  if (n.delivery_channel === "none") return t("notifications.delivery.inStugaOnly");
  const channel = channelName(n.delivery_channel);
  if (n.delivered_at) return t("notifications.delivery.sent", { channel });
  if (n.delivery_error) return notSentLine(channel, n.delivery_error);
  return t("notifications.delivery.sending", { channel });
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
      label={t("common.notifications")}
      content={
        <List hasDividers header={<Text type="label">{t("common.notifications")}</Text>}>
          {(notifications ?? []).map((n) => {
            const { label, to } = present(n);
            return (
              <Item
                as="li"
                key={n.id}
                label={label}
                description={
                  n.workspace_id === null
                    ? deliveryLine(n)
                    : n.workspace_id !== active
                      ? (n.workspace_name ?? undefined)
                      : undefined
                }
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
                  ? t("notifications.tray.loadFailed")
                  : unread > 0
                    ? t("notifications.tray.showFailed")
                    : t("notifications.tray.allCaughtUp")}
              </Text>
            </li>
          )}
        </List>
      }
    >
      <span className="notif-trigger">
        <IconButton
          label={unread ? t("notifications.tray.unreadLabel", { count: unread }) : t("common.notifications")}
          variant="ghost"
          icon={<Bell size={18} />}
        />
        {unread > 0 && <span className="notif-dot" aria-hidden="true" />}
      </span>
    </Popover>
  );
}
