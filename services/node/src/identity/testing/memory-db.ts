/**
 * The database the identity routes see, in memory, with the same single-use,
 * expiry and uniqueness rules as the SQL. For the route tests only.
 */
import type {
  AccountRow,
  InviteJoin,
  OidcFlowRow,
  OidcTicketRow,
  PasskeyRow,
  PresentedSession,
  RefreshSessionRow,
  StillHolds,
} from "@stuga/db";
import type { IdentityDb } from "../db.js";

interface Invite {
  tokenHash: string;
  usesLeft: number;
  /** No use limit or no expiry: spent only on the node's own network. */
  localOnly?: boolean;
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
  /** By credential id. */
  const passkeys = new Map<string, PasskeyRow>();
  /** Accounts that said Not now to the passkey offer. */
  const offerDismissed = new Set<string>();
  /** `${alias}:${arrival}:${tokenHash}` → the device's label and first address. */
  const devices = new Map<string, { label: string; firstFrom: string | null }>();
  /** The settings row's setup choices: written only by the account that claims the node. */
  const settings: { timeZone: string | null; searchLanguages: string[] | null } = {
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
  const spend = (tokenHash: string | null | undefined, arrival: "local" | "remote" = "local"): InviteJoin | null | false | "local_only" => {
    if (!tokenHash) return null;
    const invite = invites.get(tokenHash);
    if (!invite || invite.usesLeft <= 0) return false;
    if (invite.localOnly && arrival === "remote") return "local_only";
    invite.usesLeft--;
    return { workspaceId: "w1", role: "member" };
  };

  const sessionLive = ({ sessionId, alias, arrival }: PresentedSession) =>
    [...sessions.values()].some(
      (row) =>
        row.session_id === sessionId &&
        row.alias === alias &&
        row.arrival === arrival &&
        !row.revoked_at &&
        live(new Date(row.expires_at)) &&
        (row.absolute_expires_at === null || live(new Date(row.absolute_expires_at))),
    );
  /** The SQL's guard (session-live.ts): checked and written in one synchronous step, as its lock makes it. */
  const holds = (alias: string, requires: StillHolds | null | undefined): boolean => {
    if (!requires) return true;
    if ("password" in requires) return accounts.get(alias)?.password_hash === requires.password;
    if ("passkey" in requires) return passkeys.get(requires.passkey)?.alias === alias;
    return requires.session.alias === alias && sessionLive(requires.session);
  };
  const revokeAll = (alias: string) => {
    for (const row of sessions.values()) if (row.alias === alias && !row.revoked_at) row.revoked_at = new Date().toISOString();
  };

  const db: IdentityDb = {
    async countAccounts() {
      return accounts.size;
    },
    async createLocalAccount(input) {
      // Synchronous from here on, so it is atomic as the SQL's lock makes it: the first account is decided once.
      const first = accounts.size === 0;
      if (first && !input.mayClaim) return { ok: false, reason: "setup_code_required" };
      if (!first && !input.inviteHash) return { ok: false, reason: "invite_required" };
      if (byUsername(input.username) || accounts.has(input.alias)) return { ok: false, reason: "username_taken" };
      const joined = first ? null : spend(input.inviteHash, input.arrival);
      if (joined === false) return { ok: false, reason: "invite_invalid" };
      if (joined === "local_only") return { ok: false, reason: "invite_local_only" };
      const row: AccountRow = { alias: input.alias, username: input.username, password_hash: input.passwordHash, oidc_sub: null };
      accounts.set(input.alias, row);
      names.set(input.alias, input.displayName);
      if (first) admins.add(input.alias);
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
      const joined = spend(input.inviteHash, input.arrival);
      if (joined === false) return { ok: false, reason: "invite_invalid" };
      if (joined === "local_only") return { ok: false, reason: "invite_local_only" };
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
    async linkIdentity(alias, sub, issuer, requires) {
      if (!holds(alias, requires)) return "changed";
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
    async replaceLocalPassword({ alias, passwordHash, requires }) {
      const row = accounts.get(alias);
      if (!holds(alias, requires) || !row?.password_hash) return false;
      row.password_hash = passwordHash;
      revokeAll(alias);
      return true;
    },
    async rehashLocalPassword(alias, oldHash, newHash) {
      const row = accounts.get(alias);
      if (!row || row.password_hash !== oldHash) return false;
      row.password_hash = newHash;
      return true;
    },
    async addLocalPassword(alias, passwordHash, requires) {
      const row = accounts.get(alias);
      if (!row || row.password_hash || !holds(alias, requires)) return false;
      row.password_hash = passwordHash;
      return true;
    },
    async passwordResetIsLive(tokenHash) {
      const r = resets.get(tokenHash);
      return !!r && !r.used && r.expiresAt.getTime() > Date.now();
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
    async createRefreshSession(input, requires) {
      if (!holds(input.alias, requires)) return null;
      const now = new Date().toISOString();
      const absolute = input.absoluteExpiresAt === null ? null : new Date(input.absoluteExpiresAt).toISOString();
      // The CHECK the table holds: an end at the remote address, none on the node's own network.
      if ((input.arrival === "remote") !== (absolute !== null)) throw new Error("refresh_sessions_remote_ends");
      const idle = new Date(input.expiresAt).toISOString();
      const row: RefreshSessionRow = {
        id: input.id,
        session_id: input.sessionId,
        alias: input.alias,
        token_hash: input.tokenHash,
        expires_at: absolute !== null && absolute < idle ? absolute : idle,
        created_at: now,
        revoked_at: null,
        replaced_by: null,
        arrival: input.arrival,
        signed_in_with: input.signedInWith,
        passkey_id: input.passkeyId ?? null,
        signed_in_at: now,
        confirmed_at: now,
        absolute_expires_at: absolute,
      };
      sessions.set(input.tokenHash, row);
      return { ...row };
    },
    async findRefreshSession(tokenHash) {
      const row = sessions.get(tokenHash);
      return row ? { ...row } : null;
    },
    async rotateRefreshSession(input) {
      const row = sessions.get(input.tokenHash);
      if (!row || row.revoked_at || !live(new Date(row.expires_at)) || row.arrival !== input.arrival) return null;
      if (row.absolute_expires_at !== null && !live(new Date(row.absolute_expires_at))) return null;
      row.revoked_at = new Date().toISOString();
      row.replaced_by = input.nextTokenHash;
      const idle = input.expiresAt.toISOString();
      const next: RefreshSessionRow = {
        ...row,
        id: input.id,
        token_hash: input.nextTokenHash,
        expires_at: row.absolute_expires_at !== null && row.absolute_expires_at < idle ? row.absolute_expires_at : idle,
        created_at: new Date().toISOString(),
        revoked_at: null,
        replaced_by: null,
      };
      sessions.set(input.nextTokenHash, next);
      return { ...next };
    },
    async siblingRefreshSession(input) {
      const of = sessions.get(input.of);
      if (!of || of.revoked_at || !live(new Date(of.expires_at))) return null;
      const sibling: RefreshSessionRow = { ...of, id: input.id, token_hash: input.tokenHash, created_at: new Date().toISOString() };
      sessions.set(input.tokenHash, sibling);
      return { ...sibling };
    },
    async sessionIsLive(session) {
      return sessionLive(session);
    },
    async sessionConfirmedAt({ sessionId, alias, arrival }) {
      const rows = [...sessions.values()].filter(
        (row) =>
          row.session_id === sessionId &&
          row.alias === alias &&
          row.arrival === arrival &&
          !row.revoked_at &&
          live(new Date(row.expires_at)) &&
          (row.absolute_expires_at === null || live(new Date(row.absolute_expires_at))),
      );
      if (rows.length === 0) return null;
      return new Date(Math.max(...rows.map((row) => Date.parse(row.confirmed_at))));
    },
    async confirmSession({ sessionId, alias, arrival }) {
      let n = 0;
      for (const row of sessions.values()) {
        if (row.session_id !== sessionId || row.alias !== alias || row.arrival !== arrival || row.revoked_at) continue;
        if (!live(new Date(row.expires_at)) || (row.absolute_expires_at !== null && !live(new Date(row.absolute_expires_at)))) continue;
        row.confirmed_at = new Date().toISOString();
        n++;
      }
      return n > 0;
    },
    async isKnownDevice({ alias, arrival, tokenHash }) {
      return devices.has(`${alias}:${arrival}:${tokenHash}`);
    },
    async rememberDevice({ alias, arrival, tokenHash, label, firstFrom }) {
      const key = `${alias}:${arrival}:${tokenHash}`;
      if (devices.has(key)) return false;
      devices.set(key, { label, firstFrom });
      return true;
    },
    async revokeEverything({ alias, passwordHash, requires }) {
      const row = accounts.get(alias);
      if (!row || !holds(alias, requires)) return null;
      const ended = new Set<string>();
      const liveIds = new Set<string>();
      for (const s of sessions.values()) {
        if (s.alias !== alias || s.revoked_at) continue;
        if (live(new Date(s.expires_at)) && (s.absolute_expires_at === null || live(new Date(s.absolute_expires_at)))) liveIds.add(s.session_id);
        s.revoked_at = new Date().toISOString();
        ended.add(s.session_id);
      }
      const provider = row.oidc_sub !== null;
      row.oidc_sub = null;
      let passkeyCount = 0;
      for (const [id, p] of passkeys) {
        if (p.alias !== alias) continue;
        passkeys.delete(id);
        passkeyCount++;
        for (const [hash, s2] of sessions) if (s2.passkey_id === id) sessions.delete(hash);
      }
      row.password_hash = passwordHash;
      for (const [state, flow] of flows) if (flow.link_alias === alias) flows.delete(state);
      for (const [hash, t] of tickets) if (t.alias === alias) tickets.delete(hash);
      let deviceCount = 0;
      for (const key of devices.keys()) {
        if (key.startsWith(`${alias}:`)) {
          devices.delete(key);
          deviceCount++;
        }
      }
      let links = 0;
      for (const [hash, r] of resets) {
        if (r.alias === alias && !r.used) {
          resets.delete(hash);
          links++;
        }
      }
      return {
        sessions: liveIds.size,
        sessionIds: [...ended],
        passkeys: passkeyCount,
        provider,
        apps: 0,
        api_keys: 0,
        invites: 0,
        share_links: 0,
        devices: deviceCount,
        password_links: links,
      };
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
    async endSession(tokenHash, arrival) {
      const row = sessions.get(tokenHash);
      if (!row || row.arrival !== arrival) return null;
      for (const other of sessions.values()) if (other.session_id === row.session_id) other.revoked_at ??= new Date().toISOString();
      for (const [state, flow] of flows) if (flow.link_alias === row.alias) flows.delete(state);
      return { alias: row.alias, sessionId: row.session_id };
    },
    async inviteStatus(tokenHash, arrival) {
      const invite = invites.get(tokenHash);
      if (!invite || invite.usesLeft <= 0) return "invalid";
      return invite.localOnly && arrival === "remote" ? "local_only" : "ok";
    },
    async insertPasskey(p, requires) {
      if (!holds(p.alias, requires)) return "ended";
      if (passkeys.has(p.credentialId)) return "exists";
      passkeys.set(p.credentialId, {
        credential_id: p.credentialId,
        alias: p.alias,
        rp_id: p.rpId,
        public_key: p.publicKey,
        algorithm: p.algorithm,
        sign_count: p.signCount,
        transports: [...p.transports],
        backup_eligible: p.backupEligible,
        synced: p.synced,
        name: p.name,
        created_at: new Date().toISOString(),
        last_used_at: null,
      });
      return "added";
    },
    async findPasskey(credentialId, rpId) {
      const p = passkeys.get(credentialId);
      return p && p.rp_id === rpId ? { ...p } : null;
    },
    async passkeyDescriptors(alias, rpId) {
      return [...passkeys.values()].filter((p) => p.alias === alias && p.rp_id === rpId).map((p) => ({ id: p.credential_id, transports: p.transports }));
    },
    async recordPasskeyUse({ credentialId, signCount, synced }) {
      const p = passkeys.get(credentialId);
      if (!p) return false;
      if (!(p.sign_count < signCount || (p.sign_count === 0 && signCount === 0))) return false;
      p.sign_count = signCount;
      p.synced = synced;
      p.last_used_at = new Date().toISOString();
      return true;
    },
    async passkeyOfferDue(alias, rpId) {
      return accounts.has(alias) && !offerDismissed.has(alias) && ![...passkeys.values()].some((p) => p.alias === alias && p.rp_id === rpId);
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
        confirm_session: input.confirmSession ?? null,
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
  /** Remove a passkey as the account API does: the sign-ins it made go with it. */
  const removePasskey = (credentialId: string): string[] => {
    const ended = [...sessions.values()].filter((row) => row.passkey_id === credentialId).map((row) => row.session_id);
    passkeys.delete(credentialId);
    for (const [hash, row] of sessions) if (row.passkey_id === credentialId) sessions.delete(hash);
    return [...new Set(ended)];
  };
  return { db, accounts, sessions, invites, admins, resets, flows, tickets, names, emails, settings, devices, passkeys, offerDismissed, removePasskey };
}

