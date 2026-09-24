/**
 * The pointer a write's answer carries to the instructions for agents that
 * govern the item, by label. A write needs no read, so this is where an agent
 * that never read the item learns they exist; the read carries their text. The
 * workspace's own are left out: an agent has those from its connection.
 */
export function instructionsPointer(labels: string[] | undefined, readWith: string): string {
  if (!labels?.length) return "";
  return (
    ` Standing instructions for agents apply here beyond the workspace's: ${labels.join(", ")}. ` +
    `If you have not read them in this session, get them with ${readWith} before writing here again, ` +
    "and revise this change if it goes against them."
  );
}
