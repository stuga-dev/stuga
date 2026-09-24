/** The active workspace, sent as x-stuga-workspace. The server ignores one the caller is not a member of. */
import { readStored, removeStored, writeStored } from "../storage";

const WORKSPACE_KEY = "stuga_workspace";

export function getActiveWorkspace(): string | null {
  return readStored("local", WORKSPACE_KEY);
}

export function setActiveWorkspace(workspaceId: string | null): void {
  if (workspaceId) writeStored("local", WORKSPACE_KEY, workspaceId);
  else removeStored("local", WORKSPACE_KEY);
}
