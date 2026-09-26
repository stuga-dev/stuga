/** What the identity routes need from the database, as an interface the route tests implement in memory. */
import {
  addLocalPassword,
  countAccounts,
  createLocalAccount,
  createOidcFlow,
  createOidcTicket,
  createProviderAccount,
  createRefreshSession,
  endRefreshSession,
  findAccountByAlias,
  findAccountBySub,
  findAccountByUsername,
  findRefreshSession,
  getUserDisplayName,
  isWorkspaceInviteRedeemable,
  linkIdentity,
  peekOidcTicket,
  redeemPasswordReset,
  revokeRefreshSession,
  revokeRefreshSessions,
  rotateRefreshSession,
  takeOidcFlow,
  takeOidcTicket,
  takenUsernames,
  unlinkIdentity,
  updateLocalPassword,
  type AccountRow,
  type LinkOutcome,
  type NewAccount,
  type OidcFlowRow,
  type OidcTicketRow,
  type RefreshSessionRow,
  type SearchLanguage,
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
    /** Setup's choice about looking for newer versions; `false` is stored with the first account, and only with it. */
    updateCheck?: boolean;
    /** Setup's browser's time zone, the node's for scheduled work; stored with the first account, and only with it. */
    timeZone?: string;
    /** Setup's search languages, `[]` for none; stored with the first account, and only with it. */
    searchLanguages?: readonly SearchLanguage[];
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
  }): Promise<NewAccount<"username_taken" | "already_linked" | "setup_required" | "provider_changed">>;
  findAccountByUsername(username: string): Promise<AccountRow | null>;
  findAccountByAlias(alias: string): Promise<AccountRow | null>;
  findAccountBySub(sub: string): Promise<AccountRow | null>;
  displayNameOf(alias: string): Promise<string | null>;
  takenUsernames(usernames: string[]): Promise<Set<string>>;
  /** Linked only while `issuer`, which vouched for the subject, is still the node's (`provider_changed`). */
  linkIdentity(alias: string, sub: string, issuer: string): Promise<LinkOutcome>;
  unlinkIdentity(alias: string): Promise<"unlinked" | "not_linked" | "no_password">;

  createRefreshSession(input: { id: string; alias: string; tokenHash: string; expiresAt: Date }): Promise<RefreshSessionRow>;
  findRefreshSession(tokenHash: string): Promise<RefreshSessionRow | null>;
  rotateRefreshSession(input: {
    tokenHash: string;
    id: string;
    nextTokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshSessionRow | null>;
  revokeRefreshSession(tokenHash: string): Promise<boolean>;
  revokeRefreshSessions(alias: string): Promise<number>;
  /** Sign out: revoke the session and drop its account's unfinished provider links. The account, or null for an unknown token. */
  endSession(tokenHash: string): Promise<string | null>;

  /** A cheap refusal before a password is hashed; the account's own transaction is what spends the invite. */
  inviteIsRedeemable(tokenHash: string): Promise<boolean>;

  /** False when the account has no password to change. */
  updateLocalPassword(alias: string, passwordHash: string): Promise<boolean>;
  /** False when the account already has a password. */
  addLocalPassword(alias: string, passwordHash: string): Promise<boolean>;
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
    linkIdentity: (alias, sub, issuer) => linkIdentity(sql, alias, sub, issuer),
    unlinkIdentity: (alias) => unlinkIdentity(sql, alias),
    createRefreshSession: (input) => createRefreshSession(sql, input),
    findRefreshSession: (tokenHash) => findRefreshSession(sql, tokenHash),
    rotateRefreshSession: (input) => rotateRefreshSession(sql, input),
    revokeRefreshSession: (tokenHash) => revokeRefreshSession(sql, tokenHash),
    revokeRefreshSessions: (alias) => revokeRefreshSessions(sql, alias),
    endSession: (tokenHash) => endRefreshSession(sql, tokenHash),
    inviteIsRedeemable: (tokenHash) => isWorkspaceInviteRedeemable(sql, tokenHash),
    updateLocalPassword: (alias, passwordHash) => updateLocalPassword(sql, alias, passwordHash),
    addLocalPassword: (alias, passwordHash) => addLocalPassword(sql, alias, passwordHash),
    redeemPasswordReset: (tokenHash, passwordHash) => redeemPasswordReset(sql, tokenHash, passwordHash),
    createOidcFlow: (input) => createOidcFlow(sql, input),
    takeOidcFlow: (state) => takeOidcFlow(sql, state),
    createOidcTicket: (input) => createOidcTicket(sql, input),
    peekOidcTicket: (ticketHash, kind) => peekOidcTicket(sql, ticketHash, kind),
    takeOidcTicket: (ticketHash, kind) => takeOidcTicket(sql, ticketHash, kind),
  };
}
