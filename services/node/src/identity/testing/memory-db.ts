/**
 * The database the identity routes see, in memory, with the same single-use,
 * expiry and uniqueness rules as the SQL. For the route tests only.
 */
import type { AccountRow, InviteJoin, OidcFlowRow, OidcTicketRow, RefreshSessionRow } from "@stuga/db";
import { SEARCH_LANGUAGES } from "@stuga/protocol/domain/search-languages";
import type { IdentityDb } from "../db.js";

interface Invite {
  tokenHash: string;
  usesLeft: number;
}

/**
 * `issuer` is the node's identity provider as its settings row holds it: a
 * subject is linked only while the issuer that vouched for it is still that one.
 */
export function memoryDb(opts: { issuer?: () => string | null } = {}) {
  const currentIssuer = opts.issuer ?? (() => null);
  const accounts = new Map<string, AccountRow>(); // by alias
  const admins = new Set<string>();
  const resets = new Map<string, { alias: string; expiresAt: Date; used: boolean }>();
  const names = new Map<string, string>(); // alias → display name
  const emails = new Map<string, string | null>();
  const sessions = new Map<string, RefreshSessionRow>(); // by token hash
  const invites = new Map<string, Invite>();
  const flows = new Map<string, OidcFlowRow>();
  const tickets = new Map<string, OidcTicketRow>();
  /** The settings row's setup choices: written only by the account that claims the node. */
  const settings: { updateCheck: boolean | null; timeZone: string | null; searchLanguages: string[] | null } = {
    updateCheck: null,
    timeZone: null,
    searchLanguages: null,
  };

  const byUsername = (typed: string) => {
    const username = typed.trim().replace(/^@/, "").toLowerCase();
    return [...accounts.values()].find((a) => a.username === username) ?? null;
  };
  const bySub = (sub: string) => [...accounts.values()].find((a) => a.oidc_sub === sub) ?? null;
  const copy = (a: AccountRow | null | undefined) => (a ? { ...a } : null);
  const live = (at: Date) => at.getTime() > Date.now();
  /** Spend a use of an invite as account creation does, in the same step: false when it has none left. */
  const spend = (tokenHash: string | null | undefined): InviteJoin | null | false => {
    if (!tokenHash) return null;
    const invite = invites.get(tokenHash);
    if (!invite || invite.usesLeft <= 0) return false;
    invite.usesLeft--;
    return { workspaceId: "w1", role: "member" };
  };

  const db: IdentityDb = {
    async countAccounts() {
      return accounts.size;
    },
    async searchLanguages() {
      return settings.searchLanguages ? SEARCH_LANGUAGES.filter((l) => settings.searchLanguages!.includes(l)) : null;
    },
    async createLocalAccount(input) {
      // Synchronous from here on, so it is atomic as the SQL's lock makes it: the first account is decided once.
      const first = accounts.size === 0;
      if (first && !input.mayClaim) return { ok: false, reason: "setup_code_required" };
      if (!first && !input.inviteHash) return { ok: false, reason: "invite_required" };
      if (byUsername(input.username) || accounts.has(input.alias)) return { ok: false, reason: "username_taken" };
      const joined = first ? null : spend(input.inviteHash);
      if (joined === false) return { ok: false, reason: "invite_invalid" };
      const row: AccountRow = { alias: input.alias, username: input.username, password_hash: input.passwordHash, oidc_sub: null };
      accounts.set(input.alias, row);
      names.set(input.alias, input.displayName);
      if (first) admins.add(input.alias);
      if (first && input.updateCheck === false) settings.updateCheck = false;
      if (first && input.timeZone) settings.timeZone = input.timeZone;
      if (first && input.searchLanguages) settings.searchLanguages = [...input.searchLanguages];
      return { ok: true, account: { ...row }, joined, admin: first };
    },
    async createProviderAccount(input) {
      if (accounts.size === 0) return { ok: false, reason: "setup_required" };
      if (!input.inviteHash) return { ok: false, reason: "invite_required" };
      if (input.issuer !== currentIssuer()) return { ok: false, reason: "provider_changed" };
      if (bySub(input.oidcSub)) return { ok: false, reason: "already_linked" };
      if (byUsername(input.username) || accounts.has(input.alias)) return { ok: false, reason: "username_taken" };
      const joined = spend(input.inviteHash);
      if (joined === false) return { ok: false, reason: "invite_invalid" };
      const row: AccountRow = { alias: input.alias, username: input.username, password_hash: null, oidc_sub: input.oidcSub };
      accounts.set(input.alias, row);
      names.set(input.alias, input.displayName);
      emails.set(input.alias, input.email);
      return { ok: true, account: { ...row }, joined, admin: false };
    },
    async findAccountByUsername(username) {
      return copy(byUsername(username));
    },
    async findAccountByAlias(alias) {
      return copy(accounts.get(alias));
    },
    async findAccountBySub(sub) {
      return copy(bySub(sub));
    },
    async displayNameOf(alias) {
      return names.get(alias) ?? null;
    },
    async takenUsernames(usernames) {
      return new Set(usernames.filter((u) => byUsername(u)));
    },
    async linkIdentity(alias, sub, issuer) {
      if (issuer !== currentIssuer()) return "provider_changed";
      const holder = bySub(sub);
      if (holder) return holder.alias === alias ? "already_linked" : "taken";
      const row = accounts.get(alias);
      if (!row) return "no_account";
      if (row.oidc_sub) return "other_sub";
      row.oidc_sub = sub;
      return "linked";
    },
    async unlinkIdentity(alias) {
      const row = accounts.get(alias);
      if (!row?.oidc_sub) return "not_linked";
      if (!row.password_hash) return "no_password";
      row.oidc_sub = null;
      return "unlinked";
    },
    async updateLocalPassword(alias, passwordHash) {
      const row = accounts.get(alias);
      if (!row?.password_hash) return false;
      row.password_hash = passwordHash;
      return true;
    },
    async addLocalPassword(alias, passwordHash) {
      const row = accounts.get(alias);
      if (!row || row.password_hash) return false;
      row.password_hash = passwordHash;
      return true;
    },
    async redeemPasswordReset(tokenHash, passwordHash) {
      const r = resets.get(tokenHash);
      if (!r || r.used || r.expiresAt.getTime() <= Date.now()) return null;
      const row = accounts.get(r.alias);
      if (!row) return null;
      r.used = true;
      row.password_hash = passwordHash;
      return r.alias;
    },
    async createRefreshSession(input) {
      const row: RefreshSessionRow = {
        id: input.id,
        alias: input.alias,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt.toISOString(),
        created_at: new Date().toISOString(),
        revoked_at: null,
        replaced_by: null,
      };
      sessions.set(input.tokenHash, row);
      return row;
    },
    async findRefreshSession(tokenHash) {
      return sessions.get(tokenHash) ?? null;
    },
    async rotateRefreshSession(input) {
      const row = sessions.get(input.tokenHash);
      if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) return null;
      row.revoked_at = new Date().toISOString();
      row.replaced_by = input.nextTokenHash;
      return db.createRefreshSession({
        id: input.id,
        alias: row.alias,
        tokenHash: input.nextTokenHash,
        expiresAt: input.expiresAt,
      });
    },
    async revokeRefreshSession(tokenHash) {
      const row = sessions.get(tokenHash);
      if (!row || row.revoked_at) return false;
      row.revoked_at = new Date().toISOString();
      return true;
    },
    async revokeRefreshSessions(alias) {
      let n = 0;
      for (const row of sessions.values()) {
        if (row.alias === alias && !row.revoked_at) {
          row.revoked_at = new Date().toISOString();
          n++;
        }
      }
      return n;
    },
    async endSession(tokenHash) {
      const row = sessions.get(tokenHash);
      if (!row) return null;
      row.revoked_at ??= new Date().toISOString();
      for (const [state, flow] of flows) if (flow.link_alias === row.alias) flows.delete(state);
      return row.alias;
    },
    async inviteIsRedeemable(tokenHash) {
      return (invites.get(tokenHash)?.usesLeft ?? 0) > 0;
    },
    async createOidcFlow(input) {
      flows.set(input.state, {
        state: input.state,
        binding_hash: input.bindingHash,
        nonce: input.nonce,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        prompt: input.prompt,
        link_alias: input.linkAlias,
        return_to: input.returnTo,
        expires_at: input.expiresAt,
        created_at: new Date(),
      });
    },
    async takeOidcFlow(state) {
      const flow = flows.get(state);
      flows.delete(state);
      return flow && live(flow.expires_at) ? flow : null;
    },
    async createOidcTicket(input) {
      tickets.set(input.ticketHash, {
        ticket_hash: input.ticketHash,
        kind: input.kind,
        binding_hash: input.bindingHash,
        alias: input.alias ?? null,
        sub: input.sub ?? null,
        issuer: input.issuer ?? null,
        preferred_username: input.preferredUsername ?? null,
        name: input.name ?? null,
        email: input.email ?? null,
        return_to: input.returnTo,
        expires_at: input.expiresAt,
        created_at: new Date(),
      });
    },
    async peekOidcTicket(ticketHash, kind) {
      const t = tickets.get(ticketHash);
      return t && t.kind === kind && live(t.expires_at) ? t : null;
    },
    async takeOidcTicket(ticketHash, kind) {
      const t = await db.peekOidcTicket(ticketHash, kind);
      if (t) tickets.delete(ticketHash);
      return t;
    },
  };
  return { db, accounts, sessions, invites, admins, resets, flows, tickets, names, emails, settings };
}

