import { api } from "../lib/http/client";

export interface Notification {
  id: string;
  /** The tray spans every workspace the caller belongs to. Null on a row about the node itself, which its administrators get. */
  workspace_id: string | null;
  workspace_name: string | null;
  event_type: string;
  resource_id: string | null;
  resource_title: string | null;
  resource_url: string | null;
  actor_alias: string | null;
  /** What it says, as its event's params (@stuga/protocol/notify/events): the reader's language writes the text. */
  payload?: Record<string, unknown>;
  read: boolean;
  created_at: string;
  /** The sink it was also sent through, as set up when it was written; "none" when shown in Stuga only, null when not recorded. */
  delivery_channel?: string | null;
  /** When the sink took it. */
  delivered_at?: string | null;
  /** Why the last attempt failed, until one succeeds. */
  delivery_error?: string | null;
}

export const Notifications = {
  unread: () => api<{ unread: number }>("/api/notifications/unread"),
  list: (limit = 20) => api<{ notifications: Notification[] }>(`/api/notifications?limit=${limit}`),
  /** `ids` marks those rows; `before` (a created_at watermark) marks everything up to it; neither marks everything. */
  markRead: (opts?: { ids?: string[]; before?: string }) =>
    api<{ ok: boolean; updated: number }>("/api/notifications/read", {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    }),
};
