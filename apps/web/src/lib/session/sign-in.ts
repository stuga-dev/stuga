/** Sign-in, sign-up and the account's own credentials, against the node's auth routes. */
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { formatLocale, t } from "../../i18n/i18n";
import { atRemoteAddress } from "./auth-config";
import { authRequest } from "./auth-request";
import { AuthError } from "./errors";
import { clearLinkPending, clearSsoHint, markLinkPending, startProviderSignIn } from "./provider";
import { withConfirmation } from "./reauth";
import { authPost, ensureFreshToken, type Session, type TokenResponse } from "./tokens";

function toSession(tokens: TokenResponse): Session {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    ...(tokens.passkey_offer ? { passkeyOffer: true } : {}),
  };
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

function toProviderSession(tokens: TokenResponse): ProviderSession {
  return { session: toSession(tokens), returnTo: tokens.return_to };
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

/** A first password for an account that has none: the session is the only proof it can give, confirmed recently. */
export async function setFirstPassword(newPassword: string): Promise<void> {
  await withConfirmation(async () => authRequest("/auth/password", { new_password: newPassword }, await bearer()));
}

/** Confirm it's you with your password: the node counts this session as confirmed for five minutes. */
export async function confirmWithPassword(password: string): Promise<void> {
  await authRequest("/auth/confirm", { password }, await bearer());
}

/** Confirm it's you by signing in at the provider again; it comes back to `returnTo` with ?reauth=. */
export async function confirmWithProvider(returnTo: string): Promise<void> {
  await startProviderSignIn({ prompt: "login", returnTo, bearer: await bearer() });
}

/**
 * Revoke everything: every session at every address ends, and the provider link, apps,
 * API keys and the links you shared go. `newPassword` becomes the only way back in, and this
 * browser gets the one new session.
 */
export async function revokeEverything(newPassword: string): Promise<Session> {
  return toSession(await withConfirmation(async () => authPost("/auth/revoke-everything", { new_password: newPassword }, await bearer())));
}

/**
 * Change the password; the node ends every other session and answers with a fresh one for this
 * browser. On the node's own network the current password is the proof. At the remote address the
 * session is: one confirmed in the last five minutes, which the app asks for first when it is older,
 * so a password too short to sign in there can still be replaced from there.
 */
export async function changePassword(username: string, currentPassword: string, newPassword: string): Promise<Session> {
  if (atRemoteAddress()) {
    return toSession(await withConfirmation(async () => authPost("/auth/password", { new_password: newPassword }, await bearer())));
  }
  const body = { username, current_password: currentPassword, new_password: newPassword };
  return toSession(await authPost("/auth/password", body));
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
    await withConfirmation(async () => startProviderSignIn({ returnTo, bearer: await bearer() }));
  } catch (err) {
    clearLinkPending();
    throw err;
  }
}

/** Unlink the provider; the node refuses while the account has no password. */
export async function unlinkProvider(): Promise<void> {
  await withConfirmation(async () => authRequest("/auth/oidc/unlink", {}, await bearer()));
  // The login page would otherwise try the provider for an account it no longer reaches.
  clearSsoHint();
}

/** One rule of the password policy. */
export interface PasswordRule {
  /** The checklist line: "A letter". */
  label: string;
  /** The rule inside the one-sentence policy: "a letter". Without one, the label with a lowercase first letter. */
  requirement?: string;
  test: (pw: string, strong: boolean) => boolean;
}

/** The shortest password the node takes. */
const MIN_LENGTH = 8;

/**
 * The node's password policy, mirrored for the form; the server stays the authority, and asks only
 * for the length. A password that meets the remote address's rule (`strong`: 15 characters or more,
 * hard to guess) needs no letter or number, so a passphrase such as "trumpet walnut ceiling" works.
 * Getters, so each label is read in the interface language when it is shown.
 */
export const PASSWORD_RULES: PasswordRule[] = [
  {
    get label() {
      return t("auth.passwordRules.length", { count: MIN_LENGTH });
    },
    test: (pw) => pw.length >= MIN_LENGTH,
  },
  {
    get label() {
      return t("auth.passwordRules.letter");
    },
    get requirement() {
      return t("auth.passwordRules.letterInSentence");
    },
    test: (pw, strong) => strong || /[A-Za-z]/.test(pw),
  },
  {
    get label() {
      return t("auth.passwordRules.number");
    },
    get requirement() {
      return t("auth.passwordRules.numberInSentence");
    },
    test: (pw, strong) => strong || /\d/.test(pw),
  },
];

export function passwordOk(pw: string, strong = false): boolean {
  return PASSWORD_RULES.every((r) => r.test(pw, strong));
}

/**
 * The policy in one sentence, for a form without the live checklist: "At least 8 characters, with a
 * letter and a number." For a password that meets the remote rule (`strong`), only the length.
 */
export function passwordRulesText(strong = false): string {
  const [first, ...rest] = PASSWORD_RULES.filter((r) => !strong || !r.test("", true));
  if (!first) return "";
  if (rest.length === 0) return t("auth.passwordRules.sentenceOnly", { first: first.label });
  const phrases = rest.map((r) => r.requirement ?? r.label.charAt(0).toLocaleLowerCase(formatLocale()) + r.label.slice(1));
  const last = phrases.pop()!;
  let list = phrases.shift();
  if (list === undefined) return t("auth.passwordRules.sentenceWith", { first: first.label, rest: last });
  for (const next of phrases) list = t("auth.passwordRules.listMore", { list, next });
  return t("auth.passwordRules.sentenceWith", { first: first.label, rest: t("auth.passwordRules.listPair", { list, last }) });
}
