import { api } from "../lib/http/client";

/** A workspace group: a `group:<name>` principal and the people in it. */
export interface GroupInfo {
  group_id: string;
  /** `user:<alias>` principals. */
  members: string[];
  updated_at: string;
}

export const Groups = {
  /** Everyone but a guest may list them. */
  list: () => api<{ groups: GroupInfo[] }>("/api/groups"),
  /** Owner or admin: create the group or replace who is in it. */
  setMembers: (groupId: string, members: string[]) =>
    api<{ group_id: string; members: number }>(`/api/groups/${encodeURIComponent(groupId)}`, {
      method: "PUT",
      body: JSON.stringify({ members }),
    }),
};

/** A group's name as people read it: its principal without the prefix. */
export function groupName(groupId: string): string {
  return groupId.startsWith("group:") ? groupId.slice("group:".length) : groupId;
}
