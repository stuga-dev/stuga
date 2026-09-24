/** `/api/me/nodes`: a person's bookmarks to other Stuga nodes, which the workspace switcher opens. */

/** Bookmarks one person may keep. */
export const MAX_OTHER_NODES = 50;

/** Longest bookmark label. */
export const MAX_NODE_LABEL_CHARS = 80;

export interface OtherNode {
  id: string;
  label: string;
  /** Scheme, host and port only; opening the bookmark navigates the page there. */
  origin: string;
}

export interface OtherNodes {
  /** This node: its name and the origin people reach it at. */
  current: { name: string; origin: string };
  /** In the order they were added. */
  nodes: OtherNode[];
}
