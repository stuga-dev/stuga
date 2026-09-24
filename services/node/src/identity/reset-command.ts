/**
 * `stuga-node reset-password <username>`: the way back in when the only
 * administrator forgot their password, or never set one. It needs a shell on
 * the node's machine, which can already read the signing key, so it skips the
 * administrator check. The audit row is awaited: a credential minted with no session must be recorded.
 */
import { createClient, closeClients, findAccountByUsername, insertAuditEvents } from "@stuga/db";
import type { OpsConfig } from "../config/env.js";
import { refused, type ExitCode } from "../ops/outcome.js";
import { mintPasswordReset, resetUrl, RESET_TTL_MS } from "./reset.js";

export const RESET_PASSWORD_USAGE = "stuga-node reset-password <username>";

export async function runResetPassword(
  usernameArg: string | undefined,
  config: () => Pick<OpsConfig, "databaseUrl" | "publicOrigin">,
  out: (text: string) => void,
): Promise<ExitCode> {
  const username = usernameArg?.trim().replace(/^@/, "").toLowerCase();
  if (!username || username.startsWith("-")) throw refused(`usage: ${RESET_PASSWORD_USAGE}`);
  const ops = config();

  const sql = createClient(ops.databaseUrl);
  try {
    const account = await findAccountByUsername(sql, username);
    if (!account) throw refused(`no account with that username on this node: ${username}`);

    const { token, expiresAt } = await mintPasswordReset(sql, {
      alias: account.alias,
      createdBy: "console",
    });

    await insertAuditEvents(sql, [
      {
        workspaceId: null,
        actor: "console",
        actorKind: "internal",
        source: "internal",
        action: "node.password_reset.mint",
        targetKind: "node",
        targetId: ops.publicOrigin,
        // Never the token.
        detail: { alias: account.alias, expires_at: expiresAt.toISOString(), via: "console" },
      },
    ]);

    const hours = Math.round(RESET_TTL_MS / 3_600_000);
    out(
      `\nReset link for ${account.alias} (@${account.username}), valid ${hours}h:\n\n` +
        `  ${resetUrl(ops.publicOrigin, token)}\n\n` +
        `Open it in a browser to set a new password. It is shown once — only its hash\n` +
        `is stored, so this cannot be printed again. Run the command once more to mint\n` +
        `another. If that URL is not the origin you reach this node at, PUBLIC_ORIGIN\n` +
        `does not match reality and every other link the node mints is wrong too.\n`,
    );
    return 0;
  } finally {
    await closeClients();
  }
}
