/**
 * "Confirmed in the last five minutes" (docs/api.md): what a change that could hand someone else a
 * lasting way in asks of the session making it, on both listeners. A sign-in confirms; so does a
 * later confirmation by password (`POST /auth/confirm`) or through the provider, which moves only
 * the sign-in's `confirmed_at`, never when it ends.
 *
 * Refused with `401 reauth_required` and the `methods` the person can confirm with, marked by the
 * `x-stuga-reauth` header so a client tells it from an ended session, which is also a 401.
 */
import { findAccountByAlias, hasPasskeyAt, sessionConfirmedAt, type AccountRow } from "@stuga/db";
import type { AccountCtx } from "../auth/context.js";
import type { PersonToken } from "../auth/person-token.js";
import type { IdentityDb } from "./db.js";
import { fail, json } from "./http.js";

export const RECENT_CONFIRMATION_MS = 5 * 60 * 1000;

/** On a `reauth_required` answer, so it is never mistaken for an ended session. */
export const REAUTH_HEADER = "x-stuga-reauth";

/** Whether the sign-in `token` names was confirmed within the last five minutes. */
export async function confirmedRecently(db: Pick<IdentityDb, "sessionConfirmedAt">, token: PersonToken, now = Date.now()): Promise<boolean> {
  const at = await db.sessionConfirmedAt({ sessionId: token.sid, alias: token.alias, arrival: token.arrival });
  return at !== null && now - at.getTime() < RECENT_CONFIRMATION_MS;
}

/**
 * The ways this person can confirm: a passkey (at the remote address, for one made there), their
 * password, or a fresh sign-in through the provider they are linked to.
 */
export function confirmationMethods(
  account: Pick<AccountRow, "password_hash" | "oidc_sub"> | null,
  providerOn: boolean,
  passkey = false,
): string[] {
  const methods: string[] = [];
  if (passkey) methods.push("passkey");
  if (account?.password_hash) methods.push("password");
  if (account?.oidc_sub && providerOn) methods.push("provider");
  return methods;
}

/** The 401 that asks for a confirmation first, naming the ways this person has. */
export function reauthRequired(methods: string[]): Response {
  return json({ error: "reauth_required", message: "confirm it's you", methods }, 401, { [REAUTH_HEADER]: "1" });
}

/**
 * For an API route that changes how someone gets in (docs/api.md): null when the caller's session was
 * confirmed in the last five minutes, else the refusal. An agent's credential is refused outright.
 */
export async function recentConfirmationRequired(ctx: AccountCtx): Promise<Response | null> {
  if (ctx.isAgent) return fail(403, "agent_forbidden", "only the person can do this, not an agent acting for them");
  const at = await sessionConfirmedAt(ctx.sql, { sessionId: ctx.sid, alias: ctx.alias, arrival: ctx.arrival });
  if (at !== null && Date.now() - at.getTime() < RECENT_CONFIRMATION_MS) return null;
  const account = await findAccountByAlias(ctx.sql, ctx.alias);
  const host = ctx.arrival === "remote" ? URL.parse(ctx.servedOrigin)?.hostname : undefined;
  const passkey = host !== undefined && (await hasPasskeyAt(ctx.sql, ctx.alias, host));
  return reauthRequired(confirmationMethods(account, ctx.env.settings.current().identityProvider !== null, passkey));
}
