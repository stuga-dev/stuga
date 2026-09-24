import { principalsFrom, userPrincipal } from "@stuga/auth";
import { getGroupsForMember, type Sql } from "@stuga/db";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";

/** A member's principal set in one workspace, with their groups read from Postgres. */
export async function resolvePrincipals(
  sql: Sql,
  alias: string,
  workspaceId: string,
  role: WorkspaceRole,
): Promise<string[]> {
  const groups = await getGroupsForMember(sql, userPrincipal(alias), workspaceId);
  return principalsFrom(
    alias,
    workspaceId,
    role,
    groups.map((g) => g.group_id),
  );
}
