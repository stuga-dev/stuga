/** What the identity routes need from the database, as an interface the route tests implement in memory. */
import {
  addLocalPassword,
  confirmSession,
  countAccounts,
  createLocalAccount,
  createOidcFlow,
  createOidcTicket,
  createProviderAccount,
  createRefreshSessionIf,
  endRefreshSession,
  findAccountByAlias,
  findAccountBySub,
  findAccountByUsername,
  findRefreshSession,
  getUserDisplayName,
  isKnownDevice,
  linkIdentity,
  peekOidcTicket,
  passwordResetIsLive,
  redeemPasswordReset,
  rehashLocalPassword,
  rememberDevice,
  replaceLocalPassword,
  revokeEverything,
  revokeRefreshSession,
  revokeRefreshSessions,
  rotateRefreshSession,
  isSessionLive,
  sessionConfirmedAt,
  siblingRefreshSession,
  takeOidcFlow,
  takeOidcTicket,
  takenUsernames,
  unlinkIdentity,
  workspaceInviteStatus,
  type AccountRow,
  type CredentialArrival,
  type KnownDeviceKey,
  type LinkOutcome,
  type NewAccount,
  type NewRefreshSession,
  type OidcFlowRow,
  type OidcTicketRow,
  type PresentedSession,
  type RefreshSessionRow,
  type RevokedEverything,
  type SearchLanguage,
  type StillHolds,
  type Sql,
} from "@stuga/db";

export interface IdentityDb {
  /** Zero means nobody has claimed the node. */
  countAccounts(): Promise<number>;
  /**
   * Decides under one lock whether this is the node's first account, which is
   * granted node administration in the same transaction (`admin`) and needs
   * `mayClaim` (`setup_code_required`); any later one needs `inviteHash`
   * (`invite_required`), spent in that transaction (`invite_invalid`).
   */
  createLocalAccount(input: {
    alias: string;
    /** Normalized and valid. */
    username: string;
    passwordHash: string;
    displayName: string;
    inviteHash?: string | null;
    /** The caller checked the setup code: only then may this be the first account. */
    mayClaim?: boolean;
    /** Setup's browser's time zone, the node's for scheduled work; stored with the first account, and only with it. */
    timeZone?: string;
    /** Setup's search languages, `[]` for none; stored with the first account, and only with it. */
    searchLanguages?: readonly SearchLanguage[];
    /** Where the account is made: an invite with no limit or no expiry is spent only locally (`invite_local_only`). */
    arrival?: CredentialArrival;
  }): Promise<NewAccount<"username_taken" | "setup_code_required">>;
  /**
   * Never the first account (`setup_required`); needs an invite as a later password account does.
   * Made only while `issuer`, which vouched for the subject, is still the node's (`provider_changed`).
   */
  createProviderAccount(input: {
    alias: string;
    username: string;
    displayName: string;
    email: string | null;
    oidcSub: string;
    issuer: string;
    inviteHash?: string | null;
    arrival?: CredentialArrival;
  }): Promise<NewAccount<"username_taken" | "already_linked" | "setup_required" | "provider_changed">>;
  findAccountByUsername(username: string): Promise<AccountRow | null>;
  findAccountByAlias(alias: string): Promise<AccountRow | null>;
  findAccountBySub(sub: string): Promise<AccountRow | null>;
  displayNameOf(alias: string): Promise<string | null>;
  takenUsernames(usernames: string[]): Promise<Set<string>>;
  /** Linked only while `issuer`, which vouched for the subject, is still the node's (`provider_changed`). */
  /** With `requires`, only while it still holds (`changed` otherwise). */
  linkIdentity(alias: string, sub: string, issuer: string, requires?: StillHolds | null): Promise<LinkOutcome>;
  unlinkIdentity(alias: string): Promise<"unlinked" | "not_linked" | "no_password">;

  /** A new sign-in; with `requires`, only while it still holds (null otherwise, nothing written). */
  createRefreshSession(input: NewRefreshSession, requires?: StillHolds | null): Promise<RefreshSessionRow | null>;
  findRefreshSession(tokenHash: string): Promise<RefreshSessionRow | null>;
  /** Only a token issued at `arrival`; its successor continues the same sign-in and never outlives it. */
  rotateRefreshSession(input: {
    tokenHash: string;
    id: string;
    nextTokenHash: string;
    expiresAt: Date;
    arrival: CredentialArrival;
  }): Promise<RefreshSessionRow | null>;
  /** A second successor of a token renewed twice at once, copying its live successor `of` (a token hash) whole. */
  siblingRefreshSession(input: { of: string; id: string; tokenHash: string }): Promise<RefreshSessionRow | null>;
  /** Whether the sign-in an access token names is still on. */
  sessionIsLive(session: PresentedSession): Promise<boolean>;
  /** When the person behind a live sign-in last proved who they are; null when it is not live. */
  sessionConfirmedAt(session: PresentedSession): Promise<Date | null>;
  /** The person behind a live sign-in proved who they are again: only its `confirmed_at` moves. False when it is not live. */
  confirmSession(session: PresentedSession): Promise<boolean>;
  revokeRefreshSession(tokenHash: string): Promise<boolean>;
  revokeRefreshSessions(alias: string): Promise<number>;
  /**
   * Sign out: revoke the sign-in and drop its account's unfinished provider links. The account and
   * the sign-in, or null for an unknown token or one issued at another listener than `arrival`.
   */
  endSession(tokenHash: string, arrival: CredentialArrival): Promise<{ alias: string; sessionId: string } | null>;

  /** Whether the account signed in from this browser before, at this listener. */
  isKnownDevice(key: KnownDeviceKey): Promise<boolean>;
  /** Note a sign-in from this browser; true when it is new to the account at this listener. */
  rememberDevice(input: KnownDeviceKey & { label: string; firstFrom: string | null }): Promise<boolean>;
  /** Take back every way into the account (packages/db account-security.ts); null for no such account. */
  revokeEverything(input: { alias: string; by: string; passwordHash: string | null; requires?: StillHolds }): Promise<RevokedEverything | null>;

  /**
   * A cheap refusal before a password is hashed; the account's own transaction is what spends the
   * invite. `local_only`: an invite with no limit or no expiry, presented at the remote address.
   */
  inviteStatus(tokenHash: string, arrival: CredentialArrival): Promise<"ok" | "invalid" | "local_only">;

  /**
   * A new password and every sign-in ended, in one step, only while `requires` still holds. False
   * when it does not, or the account has no password to change.
   */
  replaceLocalPassword(input: { alias: string; passwordHash: string; requires: StillHolds }): Promise<boolean>;
  /** A hash of the same password at the current cost, stored only while `oldHash` is still the account's. */
  rehashLocalPassword(alias: string, oldHash: string, newHash: string): Promise<boolean>;
  /** False when the account already has a password, or `requires` no longer holds. */
  addLocalPassword(alias: string, passwordHash: string, requires?: StillHolds | null): Promise<boolean>;
  /** Whether a reset token would still work, checked before the new password is hashed. */
  passwordResetIsLive(tokenHash: string): Promise<boolean>;
  /** Spend a reset and set the password; the alias, or null when unknown, expired or spent. */
  redeemPasswordReset(tokenHash: string, passwordHash: string): Promise<string | null>;

  createOidcFlow(input: Parameters<typeof createOidcFlow>[1]): Promise<void>;
  /** Spent whatever its age; returned only while live. */
  takeOidcFlow(state: string): Promise<OidcFlowRow | null>;
  createOidcTicket(input: Parameters<typeof createOidcTicket>[1]): Promise<void>;
  peekOidcTicket(ticketHash: string, kind: OidcTicketRow["kind"]): Promise<OidcTicketRow | null>;
  takeOidcTicket(ticketHash: string, kind: OidcTicketRow["kind"]): Promise<OidcTicketRow | null>;
}

export function identityDb(sql: Sql): IdentityDb {
  return {
    countAccounts: () => countAccounts(sql),
    createLocalAccount: (input) => createLocalAccount(sql, input),
    createProviderAccount: (input) => createProviderAccount(sql, input),
    findAccountByUsername: (username) => findAccountByUsername(sql, username),
    findAccountByAlias: (alias) => findAccountByAlias(sql, alias),
    findAccountBySub: (sub) => findAccountBySub(sql, sub),
    displayNameOf: (alias) => getUserDisplayName(sql, alias),
    takenUsernames: (usernames) => takenUsernames(sql, usernames),
    linkIdentity: (alias, sub, issuer, requires) => linkIdentity(sql, alias, sub, issuer, requires ?? null),
    unlinkIdentity: (alias) => unlinkIdentity(sql, alias),
    createRefreshSession: (input, requires) => createRefreshSessionIf(sql, input, requires ?? null),
    findRefreshSession: (tokenHash) => findRefreshSession(sql, tokenHash),
    rotateRefreshSession: (input) => rotateRefreshSession(sql, input),
    siblingRefreshSession: (input) => siblingRefreshSession(sql, input),
    sessionIsLive: (session) => isSessionLive(sql, session),
    sessionConfirmedAt: (session) => sessionConfirmedAt(sql, session),
    confirmSession: (session) => confirmSession(sql, session),
    revokeRefreshSession: (tokenHash) => revokeRefreshSession(sql, tokenHash),
    revokeRefreshSessions: (alias) => revokeRefreshSessions(sql, alias),
    endSession: (tokenHash, arrival) => endRefreshSession(sql, tokenHash, arrival),
    isKnownDevice: (key) => isKnownDevice(sql, key),
    rememberDevice: (input) => rememberDevice(sql, input),
    revokeEverything: (input) => revokeEverything(sql, input),
    inviteStatus: (tokenHash, arrival) => workspaceInviteStatus(sql, tokenHash, arrival),
    replaceLocalPassword: (input) => replaceLocalPassword(sql, input),
    addLocalPassword: (alias, passwordHash, requires) => addLocalPassword(sql, alias, passwordHash, requires ?? null),
    passwordResetIsLive: (tokenHash) => passwordResetIsLive(sql, tokenHash),
    rehashLocalPassword: (alias, oldHash, newHash) => rehashLocalPassword(sql, alias, oldHash, newHash),
    redeemPasswordReset: (tokenHash, passwordHash) => redeemPasswordReset(sql, tokenHash, passwordHash),
    createOidcFlow: (input) => createOidcFlow(sql, input),
    takeOidcFlow: (state) => takeOidcFlow(sql, state),
    createOidcTicket: (input) => createOidcTicket(sql, input),
    peekOidcTicket: (ticketHash, kind) => peekOidcTicket(sql, ticketHash, kind),
    takeOidcTicket: (ticketHash, kind) => takeOidcTicket(sql, ticketHash, kind),
  };
}
