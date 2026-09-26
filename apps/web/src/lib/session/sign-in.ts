/** Sign-in, sign-up and the account's own credentials, against the node's auth routes. */
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { authRequest } from "./auth-request";
import { AuthError } from "./errors";
import { clearLinkPending, clearSsoHint, markLinkPending, startProviderSignIn } from "./provider";
import { authPost, ensureFreshToken, type Session, type TokenResponse } from "./tokens";

function toSession(t: TokenResponse): Session {
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in };
}

export async function signInWithPassword(username: string, password: string): Promise<Session> {
  return toSession(await authPost("/auth/login", { username, password }));
}

/**
 * Create an account and sign it in. Only a node's first account needs no
 * `invite`, and it needs the node's setup code instead; every later one
 * registers with the invite link's token, which the node redeems as part of
 * registration.
 */
export async function signUp(
  username: string,
  password: string,
  more: {
    name?: string;
    invite?: string;
    /** Setup's choice about looking for newer versions; the node takes it only from the account that claims it. */
    updateCheck?: boolean;
    /** The node's setup code, which only the node's first account needs. */
    setupCode?: string;
    /** This browser's time zone, which setup gives the node for its schedule. */
    timeZone?: string;
    /** Setup's choice of the languages search gets a tokenizer for. */
    searchLanguages?: SearchLanguage[];
  } = {},
): Promise<Session> {
  const body: Record<string, unknown> = { username, password };
  if (more.name?.trim()) body.name = more.name.trim();
  if (more.invite?.trim()) body.invite = more.invite.trim();
  if (more.updateCheck !== undefined) body.update_check = more.updateCheck;
  if (more.setupCode?.trim()) body.setup_code = more.setupCode.trim();
  if (more.timeZone) body.time_zone = more.timeZone;
  if (more.searchLanguages) body.search_languages = more.searchLanguages;
  return toSession(await authPost("/auth/register", body));
}

/** A session from the identity provider's steps, with where the sign-in was headed. */
export interface ProviderSession {
  session: Session;
  returnTo: string | undefined;
}

function toProviderSession(t: TokenResponse): ProviderSession {
  return { session: toSession(t), returnTo: t.return_to };
}

/** Trade the one-time code /auth/complete was handed for a session. */
export async function redeemHandoff(code: string): Promise<ProviderSession> {
  return toProviderSession(await authPost("/auth/oidc/handoff", { code }));
}

/** What the provider said about someone this node does not know yet. */
export interface FirstVisitTicket {
  label: string;
  preferredUsername: string | null;
  name: string | null;
  email: string | null;
  /** An available username to offer. */
  suggestion: string;
  returnTo: string | undefined;
}

/** Read a first-visit ticket without spending it. */
export async function peekTicket(ticket: string): Promise<FirstVisitTicket> {
  const raw = await authRequest<Record<string, unknown>>("/auth/oidc/ticket", { ticket });
  const text = (key: string) => (typeof raw?.[key] === "string" && raw[key] ? (raw[key] as string) : null);
  return {
    label: text("label") ?? "",
    preferredUsername: text("preferred_username"),
    name: text("name"),
    email: text("email"),
    suggestion: text("suggestion") ?? "",
    returnTo: text("return_to") ?? undefined,
  };
}

/** A new account for the provider's identity; like sign-up, it needs an invite. */
export async function createWithProvider(ticket: string, username: string, name?: string, invite?: string): Promise<ProviderSession> {
  const body: Record<string, unknown> = { ticket, username };
  if (name?.trim()) body.name = name.trim();
  if (invite?.trim()) body.invite = invite.trim();
  return toProviderSession(await authPost("/auth/oidc/complete", body));
}

/** Link the provider's identity to an account here, proven by its password. */
export async function linkWithPassword(ticket: string, username: string, password: string): Promise<ProviderSession> {
  return toProviderSession(await authPost("/auth/oidc/link", { ticket, username, password }));
}

/** The signed-in account's access token; its absence reads like any expired session. */
async function bearer(): Promise<string> {
  const token = await ensureFreshToken();
  if (!token) throw new AuthError(401, "invalid_token");
  return token;
}

/** A first password for an account that has none: the session is the only proof it can give. */
export async function setFirstPassword(newPassword: string): Promise<void> {
  await authRequest("/auth/password", { new_password: newPassword }, await bearer());
}

/** Change the password; the node ends every other session and answers with a fresh one for this browser. */
export async function changePassword(username: string, currentPassword: string, newPassword: string): Promise<Session> {
  return toSession(
    await authPost("/auth/password", { username, current_password: currentPassword, new_password: newPassword }),
  );
}

/**
 * Redeem a reset link: a new password, and a session for its account. The
 * node ends every other session of that account. An account that has only
 * signed in through the identity provider gets its first password this way.
 */
export async function resetPassword(token: string, newPassword: string): Promise<Session> {
  return toSession(await authPost("/auth/reset", { token, new_password: newPassword }));
}

/**
 * Leave for the provider to link it to the signed-in account; it comes back to
 * `returnTo` with ?provider=. A link the node has forgotten by then comes back
 * to /login?provider=failed instead, which the mark set here turns back to Profile.
 */
export async function linkProvider(returnTo: string): Promise<void> {
  markLinkPending(returnTo);
  try {
    await startProviderSignIn({ returnTo, bearer: await bearer() });
  } catch (err) {
    clearLinkPending();
    throw err;
  }
}

/** Unlink the provider; the node refuses while the account has no password. */
export async function unlinkProvider(): Promise<void> {
  await authRequest("/auth/oidc/unlink", {}, await bearer());
  // The login page would otherwise try the provider for an account it no longer reaches.
  clearSsoHint();
}

/** The node's password policy, mirrored for the form; the server stays the authority. */
export const PASSWORD_RULES: { label: string; test: (pw: string) => boolean }[] = [
  { label: "At least 8 characters", test: (pw) => pw.length >= 8 },
  { label: "A letter", test: (pw) => /[A-Za-z]/.test(pw) },
  { label: "A number", test: (pw) => /\d/.test(pw) },
];

export function passwordOk(pw: string): boolean {
  return PASSWORD_RULES.every((r) => r.test(pw));
}

/** The policy in one sentence, for a form without the live checklist: "At least 8 characters, with a letter and a number." */
export function passwordRulesText(): string {
  const [first, ...rest] = PASSWORD_RULES.map((r) => r.label);
  if (!first) return "";
  if (rest.length === 0) return `${first}.`;
  const lower = rest.map((label) => label.charAt(0).toLowerCase() + label.slice(1));
  const last = lower.pop()!;
  return `${first}, with ${lower.length ? `${lower.join(", ")} and ${last}` : last}.`;
}
