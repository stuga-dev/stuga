/** Who a co-author turn acts as when it calls the node. */
import type { Ctx } from "../auth/context.js";
import type { NodeEnv } from "../env.js";

/** What the co-author is called wherever it is named to people, as cross-document proposals name it. */
export const PANEL_NAME = "AI co-author";

/** The principals an actor forwarded, strings only; anything else is none. */
export function principalsOf(body: { principals?: unknown }): string[] {
  return Array.isArray(body.principals) ? body.principals.filter((p): p is string => typeof p === "string") : [];
}

/**
 * The context a co-author turn acts in: its panel, `panel:<person>`, as an agent on behalf of
 * the person at the editor, so the agent gates run and the person reviews. Null when the actor
 * left out the person, the workspace or the principals.
 */
export function panelCtx(
  env: NodeEnv,
  body: { workspaceId?: unknown; principals?: unknown; alias?: unknown; agent?: unknown },
): Ctx | null {
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const alias = typeof body.alias === "string" ? body.alias : "";
  const principals = principalsOf(body);
  if (!workspaceId || !alias || principals.length === 0) return null;
  return {
    sql: env.sql,
    // The turn came from a person's editor session.
    surface: "ws",
    env,
    principals,
    workspaceId,
    // Isolation comes from the principal set; agent gates key off isAgent, not role.
    role: "member",
    alias: `panel:${alias}`,
    displayName: typeof body.agent === "string" && body.agent ? body.agent : PANEL_NAME,
    isAgent: true,
    onBehalfOf: alias,
    // Nobody is handed a link from here.
    servedOrigin: env.publicOrigin,
    arrival: "local",
  };
}
