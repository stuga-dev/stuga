/**
 * Passkeys at the remote address (docs/remote-access.md), the only place they are made and used: the
 * node's own listener answers 404 here, whether it serves http or https.
 *
 *   POST /auth/passkey/options  { purpose }   sign-in: any passkey for this host, no session
 *                                             reauth: the person's own, to confirm their session
 *                                             add: a new one, from a session confirmed in five minutes
 *   POST /auth/passkey/sign-in  { credential } sign in, or (a reauth challenge, with the session it
 *                                             names) confirm that session: 204
 *   POST /auth/passkey/add      { credential } with the session the challenge names, still confirmed
 *                                             in five minutes, and still on as the passkey is written
 *
 * Every refusal of a sign-in is the same `401 passkey_invalid`, whether the passkey is unknown, of
 * another host, or signed wrong, and counts against the source address only: a passkey names no
 * account until it is verified, so no account is ever paused by one.
 */
import {
  PasskeyInvalid,
  challengeOf,
  challengeText,
  creationOptions,
  requestOptions,
  verifyAssertion,
  verifyCreation,
  type PasskeySite,
} from "@stuga/auth";
import { arrivalOf, servedOrigin } from "../http/arrival.js";
import { clientAddress } from "../platform/http-server.js";
import { paused } from "./check-password.js";
import { deviceLabel, passkeyName } from "./devices.js";
import { fail, json, readJson } from "./http.js";
import type { PasskeyChallenges, PasskeyPurpose, PasskeyTicket } from "./passkey-challenges.js";
import type { IdentityCore } from "./routes.js";

/** The relying party a request at the remote address is for: its own host, at its own origin. */
export function passkeySite(req: Request, nodeName: string | null): PasskeySite {
  const origin = servedOrigin(req);
  return { rpId: new URL(origin).hostname, origin, rpName: nodeName ?? "Stuga" };
}

export interface PasskeyRoutes {
  options(req: Request): Promise<Response>;
  signIn(req: Request): Promise<Response>;
  add(req: Request): Promise<Response>;
}

const notHere = (): Response => fail(404, "not_found", "passkeys are used at the remote address");
const invalid = (): Response => fail(401, "passkey_invalid", "that passkey did not sign in here");

/** Which of `purposes` a challenge's ticket says it is for, read from the ticket itself. */
function ticketPurpose(text: string, purposes: readonly PasskeyPurpose[]): PasskeyPurpose | null {
  const named = text.split(".")[1];
  return purposes.find((p) => p === named) ?? null;
}

export function createPasskeyRoutes(core: IdentityCore, challenges: PasskeyChallenges): PasskeyRoutes {
  const { deps } = core;
  const db = deps.db;
  const site = (req: Request) => passkeySite(req, deps.nodeName?.() ?? null);
  const source = (req: Request) => ({ arrival: arrivalOf(req), source: clientAddress(req, false) });

  /** The credential a request carries and the ticket its challenge is, for one of `purposes`; null when either is not. */
  async function presented(
    req: Request,
    purposes: readonly PasskeyPurpose[],
  ): Promise<{ credential: unknown; ticket: PasskeyTicket; challenge: string } | null> {
    const body = await readJson(req);
    const credential = body?.credential;
    const challenge = challengeOf(credential);
    const text = challenge ? challengeText(challenge) : null;
    const purpose = text ? ticketPurpose(text, purposes) : null;
    const ticket = text && purpose ? challenges.read(text, purpose) : null;
    return ticket && challenge ? { credential, ticket, challenge } : null;
  }

  async function options(req: Request): Promise<Response> {
    if (arrivalOf(req) !== "remote") return notHere();
    const body = await readJson(req);
    const purpose = body?.purpose;
    if (purpose === "sign-in") {
      return json({ publicKey: await requestOptions({ site: site(req), challenge: challenges.issue("sign-in", null) }) });
    }
    if (purpose !== "reauth" && purpose !== "add") return fail(400, "bad_request", 'purpose must be "sign-in", "reauth" or "add"');

    const found = await core.bearerSession(req);
    if (found instanceof Response) return found;
    if (!found) return fail(401, "invalid_token", "sign in again");
    const { account, token } = found;
    const here = site(req);
    const own = await db.passkeyDescriptors(account.alias, here.rpId);
    const binding = { alias: account.alias, sid: token.sid };
    if (purpose === "reauth") {
      if (own.length === 0) return fail(400, "no_passkey", "you have no passkey for this address");
      return json({ publicKey: await requestOptions({ site: here, challenge: challenges.issue("reauth", binding), allow: own }) });
    }
    // A passkey is a lasting way in: only from a sign-in confirmed in the last five minutes.
    const stale = await core.recentlyConfirmed(req, account, token);
    if (stale) return stale;
    const displayName = (await db.displayNameOf(account.alias)) ?? account.username;
    return json({
      publicKey: await creationOptions({
        site: here,
        user: { alias: account.alias, username: account.username, displayName },
        challenge: challenges.issue("add", binding),
        exclude: own,
      }),
    });
  }

  async function signIn(req: Request): Promise<Response> {
    if (arrivalOf(req) !== "remote") return notHere();
    const from = source(req);
    const pause = core.limits.sourcePausedFor(from);
    if (pause) return paused(pause.retryAfterSeconds, "failed sign-ins");
    const refuse = (ticket?: PasskeyTicket): Response => {
      if (ticket) challenges.release(ticket);
      core.limits.passkeyFailed(from);
      return invalid();
    };

    const got = await presented(req, ["sign-in", "reauth"]);
    if (!got) return refuse();
    const { credential, ticket, challenge } = got;

    // A confirmation belongs to the sign-in it was asked for, with that sign-in's own token.
    let confirming: Awaited<ReturnType<IdentityCore["bearerSession"]>> = null;
    if (ticket.purpose === "reauth") {
      confirming = await core.bearerSession(req);
      if (confirming instanceof Response) return confirming;
      if (!confirming || confirming.token.alias !== ticket.binding?.alias || confirming.token.sid !== ticket.binding.sid) return refuse();
    }
    if (!challenges.claim(ticket)) return refuse();

    const here = site(req);
    const id = (credential as { id?: unknown }).id;
    const stored = typeof id === "string" ? await db.findPasskey(id, here.rpId) : null;
    if (!stored) return refuse(ticket);
    if (confirming && stored.alias !== confirming.account.alias) return refuse(ticket);
    let used: { signCount: number; synced: boolean };
    try {
      used = await verifyAssertion({
        site: here,
        response: credential,
        challenge,
        stored: {
          credentialId: stored.credential_id,
          alias: stored.alias,
          publicKey: stored.public_key,
          signCount: stored.sign_count,
          transports: stored.transports,
          backupEligible: stored.backup_eligible,
        },
      });
    } catch (err) {
      if (err instanceof PasskeyInvalid) return refuse(ticket);
      throw err;
    }
    // Removed while it was checked: it signs nothing in.
    if (!(await db.recordPasskeyUse({ credentialId: stored.credential_id, ...used }))) return invalid();

    if (confirming) {
      const { token } = confirming;
      if (!(await db.confirmSession({ sessionId: token.sid, alias: token.alias, arrival: token.arrival }))) {
        return fail(401, "invalid_token", "sign in again");
      }
      return new Response(null, { status: 204 });
    }
    const account = await db.findAccountByAlias(stored.alias);
    if (!account) return invalid();
    const done = await core.signInIf(req, account, "passkey", { passkey: stored.credential_id }, { passkeyId: stored.credential_id });
    return done ? core.signedIn(done) : invalid();
  }

  async function add(req: Request): Promise<Response> {
    if (arrivalOf(req) !== "remote") return notHere();
    const found = await core.bearerSession(req);
    if (found instanceof Response) return found;
    if (!found) return fail(401, "invalid_token", "sign in again");
    const { account, token } = found;
    const refused = (ticket?: PasskeyTicket) => {
      if (ticket) challenges.release(ticket);
      return fail(400, "passkey_not_added", "that passkey could not be added");
    };
    const got = await presented(req, ["add"]);
    if (!got || got.ticket.binding?.alias !== account.alias || got.ticket.binding.sid !== token.sid) return refused();
    const { credential, ticket, challenge } = got;
    // The five minutes hold for the add itself, not only for the challenge, which lives five more.
    const stale = await core.recentlyConfirmed(req, account, token);
    if (stale) return stale;
    if (!challenges.claim(ticket)) return refused();

    const here = site(req);
    let made;
    try {
      made = await verifyCreation({ site: here, response: credential, challenge });
    } catch (err) {
      if (err instanceof PasskeyInvalid) return refused(ticket);
      throw err;
    }
    const userAgent = req.headers.get("user-agent");
    const name = passkeyName({ backupEligible: made.backupEligible, transports: made.transports, userAgent });
    // Only while the sign-in that asked is on, ordered against a Revoke everything landing meanwhile.
    const asking = { session: { sessionId: token.sid, alias: token.alias, arrival: token.arrival } };
    const added = await db.insertPasskey({
      credentialId: made.credentialId,
      alias: account.alias,
      rpId: here.rpId,
      publicKey: made.publicKey,
      algorithm: made.algorithm,
      signCount: made.signCount,
      transports: made.transports,
      backupEligible: made.backupEligible,
      synced: made.synced,
      name,
    }, asking);
    if (added === "ended") return fail(401, "invalid_token", "sign in again");
    if (added === "exists") return fail(409, "passkey_exists", "that passkey is added already");
    deps.onIdentityChange?.({ alias: account.alias, action: "node.passkey.add", detail: { name, synced: made.synced } });
    await deps.alerts?.passkeyAdded({
      alias: account.alias,
      name,
      remoteHost: here.rpId,
      device: deviceLabel(userAgent),
      at: new Date(),
      from: clientAddress(req, false),
    });
    return json({ id: made.credentialId, name, synced: made.synced, backup_eligible: made.backupEligible }, 201);
  }

  return { options, signIn, add };
}
