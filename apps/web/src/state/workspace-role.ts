/** The signed-in person's role in the active workspace, for hiding what that role cannot do. */
import { useEffect, useState } from "react";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import { Workspaces } from "../api";

/** Null until known, and when it cannot be read: the server still refuses what the role may not do. */
export function useWorkspaceRole(): WorkspaceRole | null {
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  useEffect(() => {
    let alive = true;
    Workspaces.list()
      .then(({ workspaces, active }) => {
        if (alive) setRole(workspaces.find((w) => w.workspace_id === active)?.role ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return role;
}
