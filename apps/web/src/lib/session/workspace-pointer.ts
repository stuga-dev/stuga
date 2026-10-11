/** The active workspace, sent as x-stuga-workspace. The server ignores one the caller is not a member of. */
import { readStored, removeStored, writeStored } from "../storage";

const WORKSPACE_KEY = "stuga_workspace";
const WORKSPACE_NAME_KEY = "stuga_workspace_name";

export function getActiveWorkspace(): string | null {
  return readStored("local", WORKSPACE_KEY);
}

/** None: its remembered name goes too, so a shared browser keeps nothing of it after a sign-out. */
export function setActiveWorkspace(workspaceId: string | null): void {
  if (workspaceId) {
    writeStored("local", WORKSPACE_KEY, workspaceId);
    return;
  }
  removeStored("local", WORKSPACE_KEY);
  removeStored("local", WORKSPACE_NAME_KEY);
}

/** Remember what the active workspace is called, so a page can still name it once the person is no longer a member. */
export function rememberWorkspaceName(workspaceId: string, name: string): void {
  writeStored("local", WORKSPACE_NAME_KEY, JSON.stringify({ workspaceId, name }));
}

/** The remembered name of `workspaceId`, or null. */
export function workspaceName(workspaceId: string): string | null {
  try {
    const held = JSON.parse(readStored("local", WORKSPACE_NAME_KEY) ?? "null") as { workspaceId?: unknown; name?: unknown } | null;
    return held?.workspaceId === workspaceId && typeof held.name === "string" ? held.name : null;
  } catch {
    return null;
  }
}
