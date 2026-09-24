import type { OtherNode, OtherNodes as OtherNodeList } from "@stuga/protocol/api/other-nodes";
import { api } from "../lib/http/client";
import { cachedResource } from "../lib/store";

export type { OtherNode, OtherNodeList };

/** The list changes only through this app, which drops the cache on every change; the expiry picks up another tab's. */
const otherNodes = cachedResource(() => api<OtherNodeList>("/api/me/nodes"), 60_000);

async function invalidating<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } finally {
    otherNodes.invalidate();
  }
}

/** A person's bookmarks to other Stuga nodes, for the workspace switcher. */
export const OtherNodes = {
  list: () => otherNodes.get(),
  /** Only the URL's origin is kept; an empty label becomes its host. Refusals carry a `code`: `already_added`, `limit_reached`, `own_node`, `invalid_url`, `invalid_label`. */
  add: (url: string, label: string) =>
    invalidating(api<{ node: OtherNode }>("/api/me/nodes", { method: "POST", body: JSON.stringify({ url, label }) })),
  remove: (id: string) =>
    invalidating(api<void>(`/api/me/nodes/${encodeURIComponent(id)}`, { method: "DELETE" })),
  /** Called whenever a change may have altered the list. */
  onChanged: (fn: () => void) => otherNodes.subscribe(fn),
};
