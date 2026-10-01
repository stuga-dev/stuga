/**
 * Every password the node checks goes through `check`, so no route can skip a limit: sign-in, a
 * password change's current password, linking a provider identity to an existing account, and
 * every later confirmation by password. In order, each refusing before the hash is run:
 *
 *   1. over plain http from outside this network                  403 password_off_network
 *   2. longer than any password can be                             401 invalid_credentials
 *   3. the account, this device, or (remote) the source is paused  429 sign_in_paused
 *   4. at the remote address, short of the remote rule: fewer than 15 code points, or (once the
 *      scoring budget allows: 503 busy) a zxcvbn score under 3      401 remote_password_weak
 *   5. a stranger at the remote address, from a browser the account
 *      never signed in from, with the minute's budget of wrong
 *      passwords spent                                              503 busy
 *   6. hashed in the hash queue's line for the caller (or 503 busy), against the decoy when
 *      there is no account or no password, so either costs the same; a pause that began while
 *      it waited (concurrent guesses) is checked again once it has a slot   429 sign_in_paused
 *   7. wrong: counted, and a hash made at an older cost is checked against the decoy as well,
 *      so a wrong guess costs the same whether the account exists or not  401 invalid_credentials
 *   8. right, with a hash made at an older cost: hashed again and stored
 *
 * Steps 4's answer is the same whether the password is right, wrong, or for no account at all: it
 * looks only at what was typed and what a guesser already knows. New passwords are hashed through
 * `hash`, in the same queue, after the same network check as step 1.
 */
import { randomUUID } from "node:crypto";
import { HashBusy, hashPassword, needsRehash, verifyPassword, type HashLane, type HashQueue } from "@stuga/auth";
import type { AccountRow } from "@stuga/db";
import { REMOTE_MIN_CODE_POINTS, codePoints, remotePasswordOk, strengthInputs } from "@stuga/password-strength";
import { arrivalOf, servedOrigin } from "../http/arrival.js";
import { clientAddress } from "../platform/http-server.js";
import { fail, json } from "./http.js";
import type { PasswordNetworkCheck } from "./off-network.js";
import { MAX_PASSWORD } from "./passwords.js";
import { ACCOUNT_PAUSES_MIN, type SignInLimits } from "./sign-in-limits.js";

/** What a password short of the remote rule is told, right or wrong. */
export const REMOTE_PASSWORD_WEAK =
  "From outside this network, sign in with a passkey or a password of 15 characters or more that is hard to guess.";

export interface PasswordCheckInput {
  /** Normalized: as typed before sign-in, the session's account's after. */
  username: string;
  /** The account that name belongs to, or null. */
  account: AccountRow | null;
  password: string;
  /** A signed-in person confirming who they are: the priority line, outside the remote budget. */
  signedIn: boolean;
  /** The hashed cookie of a browser this account signed in from before at this listener, or null. */
  device?: string | null;
}

export type PasswordCheckResult =
  /** `hash` is the account's password hash as the check left it: the one a sign-in that follows requires still. */
  { ok: true; account: AccountRow; hash: string } | { ok: false; response: Response };

export interface PasswordChecks {
  check(req: Request, input: PasswordCheckInput): Promise<PasswordCheckResult>;
  /** A new password's hash, in the caller's line, after `admits`; the 503 when the queue is full. */
  hash(req: Request, password: string, signedIn: boolean): Promise<string | Response>;
  /** Whether a new password may be hashed for this request now: its refusal, or null. */
  admits(req: Request, signedIn: boolean): Response | null;
}

export interface PasswordChecksDeps {
  limits: SignInLimits;
  queue: HashQueue;
  network: PasswordNetworkCheck;
  /** Store a hash made at the current cost, only while the old one is still the account's. */
  rehash(alias: string, oldHash: string, newHash: string): Promise<boolean>;
  /** The node's name, which a guesser knows. */
  nodeName?: () => string | null;
  /** An account that exists reached the longest pause (an hour), at the listener the request came in on. */
  onLongPause?: (account: AccountRow, req: Request) => void;
}

const wrong = (): Response => fail(401, "invalid_credentials", "username or password is incorrect");

export function busy(): Response {
  return json({ error: "busy", message: "busy; try again in a few seconds" }, 503, { "retry-after": "5" });
}

/** The 429 while sign-ins are paused; `what` is what there were too many of. */
export function paused(retryAfterSeconds: number, what = "wrong passwords"): Response {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return json(
    {
      error: "sign_in_paused",
      message: `Too many ${what}. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
      retry_after: retryAfterSeconds,
    },
    429,
    { "retry-after": String(retryAfterSeconds) },
  );
}

/** Which line of the hash queue a request waits in: only a stranger at the remote address is held back. */
export function hashLane(req: Request, signedIn: boolean): HashLane {
  return arrivalOf(req) === "remote" && !signedIn ? "anonymous" : "priority";
}

export function createPasswordChecks(deps: PasswordChecksDeps): PasswordChecks {
  const { limits, queue } = deps;
  /** Verified against when there is no password to check, made at the current cost. */
  let decoyHash: Promise<string> | null = null;
  function decoy(lane: HashLane): Promise<string> {
    if (!decoyHash) {
      decoyHash = queue.run(lane, () => hashPassword(randomUUID()));
      decoyHash.catch(() => (decoyHash = null));
    }
    return decoyHash;
  }

  async function inQueue<T>(lane: HashLane, work: () => Promise<T>): Promise<T | Response> {
    try {
      return await queue.run(lane, work);
    } catch (err) {
      if (err instanceof HashBusy) return busy();
      throw err;
    }
  }

  return {
    async check(req, input) {
      const refused = (response: Response): PasswordCheckResult => ({ ok: false, response });
      const off = deps.network(req);
      if (off) return refused(off);
      if (input.password.length > MAX_PASSWORD) return refused(wrong());

      const remote = arrivalOf(req) === "remote";
      const attempt = {
        arrival: arrivalOf(req),
        username: input.username,
        exists: input.account !== null,
        device: input.device ?? null,
        source: clientAddress(req, false),
      };
      const pause = limits.pausedFor(attempt);
      if (pause) return refused(paused(pause.retryAfterSeconds));

      if (remote) {
        if (codePoints(input.password) < REMOTE_MIN_CODE_POINTS) {
          limits.refusedUnhashed(attempt);
          return refused(fail(401, "remote_password_weak", REMOTE_PASSWORD_WEAK));
        }
        if (!limits.takeStrengthCheck()) return refused(busy());
        const hostLabel = new URL(servedOrigin(req)).hostname.split(".")[0] ?? "";
        const inputs = strengthInputs({ username: input.username, nodeName: deps.nodeName?.() ?? null, hostLabel });
        if (!remotePasswordOk(input.password, inputs).ok) {
          limits.refusedUnhashed(attempt);
          return refused(fail(401, "remote_password_weak", REMOTE_PASSWORD_WEAK));
        }
        // A known browser and a signed-in person are outside it: a flood of guesses cannot lock either out.
        if (!input.signedIn && !attempt.device && limits.remoteBudgetSpent()) return refused(busy());
      }

      const lane = hashLane(req, input.signedIn);
      const stored = input.account?.password_hash ?? null;
      // Made once, in a slot of its own: never while holding the one it is checked in. A hash made at
      // an older cost is cheaper than the decoy, so a wrong guess against it is checked against the
      // decoy as well: the time it takes never tells an account that has not signed in since the
      // cost went up from no account at all.
      const legacy = stored !== null && needsRehash(stored);
      let target: string;
      let evener: string | null = null;
      try {
        if (stored !== null) target = stored;
        else target = await decoy(lane);
        if (legacy) evener = await decoy(lane);
      } catch (err) {
        if (err instanceof HashBusy) return refused(busy());
        throw err;
      }
      // Checked again once it has a slot, and a wrong one counted before the slot is given up:
      // concurrent guesses all pass the check above before any is counted.
      const checked = await inQueue(lane, async () => {
        const pausedNow = limits.pausedFor(attempt);
        if (pausedNow) return pausedNow;
        const match = await verifyPassword(input.password, target);
        if (!match && evener !== null) await verifyPassword(input.password, evener);
        if (input.account && stored !== null && match) return true;
        return { pausedMinutes: limits.failed(attempt) };
      });
      if (checked instanceof Response) return refused(checked);
      if (typeof checked === "object" && "retryAfterSeconds" in checked) return refused(paused(checked.retryAfterSeconds));
      if (checked !== true) {
        const { pausedMinutes } = checked;
        if (input.account && pausedMinutes !== null && pausedMinutes >= ACCOUNT_PAUSES_MIN.at(-1)!) deps.onLongPause?.(input.account, req);
        return refused(wrong());
      }
      if (!input.account || stored === null) return refused(wrong());

      if (legacy) {
        const fresh = await inQueue(lane, () => hashPassword(input.password)).catch(() => null);
        // A failed or busy rehash leaves the old hash for the next sign-in; this one has worked.
        if (typeof fresh === "string" && (await deps.rehash(input.account.alias, stored, fresh).catch(() => false))) {
          return { ok: true, account: { ...input.account, password_hash: fresh }, hash: fresh };
        }
      }
      return { ok: true, account: input.account, hash: stored };
    },

    admits(req, signedIn) {
      const off = deps.network(req);
      if (off) return off;
      // A stranger's registration or reset at the remote address waits out the minute's budget too.
      if (arrivalOf(req) === "remote" && !signedIn && limits.remoteBudgetSpent()) return busy();
      return null;
    },

    async hash(req, password, signedIn) {
      const refused = this.admits(req, signedIn);
      if (refused) return refused;
      return inQueue(hashLane(req, signedIn), () => hashPassword(password));
    },
  };
}
