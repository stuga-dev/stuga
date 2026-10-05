/**
 * `stuga-node reset-password <username>`: the way back in when the only
 * administrator forgot their password, or never set one. It needs a shell on
 * the node's machine, which can already read the signing key, so it skips the
 * administrator check. The audit row is awaited: a credential minted with no session must be recorded.
 *
 * The link is the remote address's while that is on, which opens anywhere. Otherwise it is the
 * node's own; over plain http that takes a password only from the node's network, so the command
 * also says how to reach it from elsewhere through an SSH tunnel.
 */
import { createClient, closeClients, findAccountByUsername, getRemoteAccess, insertAuditEvents } from "@stuga/db";
import type { OpsConfig } from "../config/env.js";
import { refused, type ExitCode } from "../ops/outcome.js";
import { mintPasswordReset, resetUrl, RESET_TTL_MS } from "./reset.js";

export const RESET_PASSWORD_USAGE = "stuga-node reset-password <username>";

/** How the node's own listener serves, which decides whether the link needs a tunnel from elsewhere. */
export interface ResetListener {
  /** No TLS_CERT_DIR: the listener serves plain http. */
  plainHttp: boolean;
  /** The port a tunnel reaches it on from this machine: the host's under Docker (STUGA_TUNNEL_PORT), else PORT. */
  port: number;
}

/** The listener as the environment describes it. */
export function resetListener(env: NodeJS.ProcessEnv): ResetListener {
  const port = Number(env.STUGA_TUNNEL_PORT?.trim() || env.PORT?.trim() || 8787);
  return { plainHttp: !env.TLS_CERT_DIR?.trim(), port: Number.isInteger(port) && port > 0 ? port : 8787 };
}

/** What the command prints for a minted token. */
export function resetLinkText(input: {
  alias: string;
  username: string;
  token: string;
  hours: number;
  publicOrigin: string;
  /** The remote address's hostname while it is on; null otherwise. */
  remoteHostname: string | null;
  listener: ResetListener;
}): string {
  const head = `\nReset link for ${input.alias} (@${input.username}), valid ${input.hours}h:\n\n`;
  const once =
    `It is shown once — only its hash is stored, so this cannot be printed again.\n` +
    `Run the command once more to mint another.\n`;
  if (input.remoteHostname) {
    return `${head}  ${resetUrl(`https://${input.remoteHostname}`, input.token)}\n\nOpen it in a browser anywhere to set a new password. ${once}`;
  }
  let text =
    `${head}  ${resetUrl(input.publicOrigin, input.token)}\n\n` +
    `Open it in a browser to set a new password. ${once}` +
    `If that URL is not the origin you reach this node at, PUBLIC_ORIGIN\n` +
    `does not match reality and every other link the node mints is wrong too.\n`;
  if (input.listener.plainHttp) {
    const { port } = input.listener;
    const path = new URL(resetUrl(input.publicOrigin, input.token)).pathname;
    text +=
      `\nFrom outside this network, open it through an SSH tunnel: ssh -L ${port}:127.0.0.1:${port} <this machine>,\n` +
      `then http://localhost:${port}${path}\n`;
  }
  return text;
}

export async function runResetPassword(
  usernameArg: string | undefined,
  /** Read only once the username is known to be one, so a mistyped command touches nothing. */
  config: () => Pick<OpsConfig, "databaseUrl" | "publicOrigin"> | Promise<Pick<OpsConfig, "databaseUrl" | "publicOrigin">>,
  out: (text: string) => void,
  listener: ResetListener = resetListener(process.env),
): Promise<ExitCode> {
  const username = usernameArg?.trim().replace(/^@/, "").toLowerCase();
  if (!username || username.startsWith("-")) throw refused(`usage: ${RESET_PASSWORD_USAGE}`);
  const ops = await config();

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

    const remote = await getRemoteAccess(sql);
    out(
      resetLinkText({
        alias: account.alias,
        username: account.username,
        token,
        hours: Math.round(RESET_TTL_MS / 3_600_000),
        publicOrigin: ops.publicOrigin,
        remoteHostname: remote.enabled ? remote.hostname : null,
        listener,
      }),
    );
    return 0;
  } finally {
    await closeClients();
  }
}
