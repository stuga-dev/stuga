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
  read: boolean;
  created_at: string;
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
